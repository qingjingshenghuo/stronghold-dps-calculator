import { advanceNecrosis, type necrosisProfile } from '../../effects/elemental.ts';
import { ShredClock } from '../../effects/shred-clock.ts';
import type { BattleEffects } from '../../effects/common.ts';
import { swiftNote, swiftRefundSucceeds } from '../../swift.ts';
import type { DamageComponent, PhaseResult } from '../../types.ts';
import type { GenericModel } from '../generic.ts';

export interface ElementStage {
  duration: number;
  active?: boolean;
  executeBelow?: number;
  /** 本阶段从一次技能开启开始（开技事件）。 */
  cast?: boolean;
  phase: (events: number, elapsed: number, burst: boolean, effects: BattleEffects) => PhaseResult;
}

/**
 * 迅捷回技：每次技能真实结束时按固定判定序列判定一次（第 k 个循环取第 k 次判定，开局那一轮的结束为第 0 次），
 * 成功时下一个循环改用 quick（回复时间缩短）。元素条、库存与二开状态沿同一次模拟延续。
 */
export interface ElementSwift { probability: number; quick: ElementStage[] }
export function moduleElement(model: GenericModel, profile: Pick<ReturnType<typeof necrosisProfile>, 'threshold' | 'duration' | 'buildupMultiplier'>,
  rawRate: (phase: PhaseResult) => number, opening: ElementStage[], repeat: ElementStage[], recovery: number | null, burstHit?: DamageComponent, swift?: ElementSwift,
  effectsAt?: (events: number) => BattleEffects) {
  const cycleStages = (k: number, time: number) => swift && swiftRefundSucceeds(k, swift.probability, time) ? swift.quick : repeat;
  const effects = model.battle!;
  const stableAfter = Math.max(0, effects.judgment?.until ?? 0, ...effects.timedStats.map(stat => stat.until));
  const stacks = effects.bondStacks;
  const stackCap = stacks && effectsAt ? Math.ceil(stacks.max / stacks.perDamage) : 0;
  const cap = new ShredClock(effects, stackCap).cap;
  const byCount = new Map<number, BattleEffects>([[0, effects]]);
  const panelAt = (stage: ElementStage, count: number, time: number, burst: boolean) => {
    const n = Math.min(count, stackCap);
    let current = byCount.get(n);
    if (!current) { current = effectsAt!(n); byCount.set(n, current); }
    return stage.phase(count, time, burst, current);
  };
  if (stackCap) {
    model.notes = model.notes.filter(note => !note.includes('临时盟约层数尚未逐事件重建'));
    model.notes.push('近似：补剂在各伤害分项的完整间隔结束后增加临时层数，概率段取期望次数，伊比利亚持续法伤不递归触发。技能切换保留元素条、锁条时间和已获层数。');
  }
  const stable = new Map<ElementStage, [PhaseResult, PhaseResult]>();
  const phases = (stage: ElementStage) => {
    if (!stable.has(stage)) stable.set(stage, [panelAt(stage, cap, stableAfter, false), panelAt(stage, cap, stableAfter, true)]);
    return stable.get(stage)!;
  };
  const skillParts = new Map<string, DamageComponent>();
  let skillSeconds = 0;
  let beforeCast: PhaseResult | undefined, castStats: PhaseResult['stats'] | undefined;
  const collect = (parts: DamageComponent[], seconds: number) => {
    for (const [index, part] of parts.entries()) {
      const key = `${part.source}:${part.label}:${index}`;
      const amount = seconds ? part.dps * seconds : part.perHit;
      skillParts.set(key, { ...part, dps: (skillParts.get(key)?.dps ?? 0) + amount });
    }
    skillSeconds += seconds;
  };
  const run = (window: number, hp: number, preview = false) => {
    const state = { buildup: 0, remaining: 0 }, clock = new ShredClock(effects, stackCap);
    let time = 0, dealt = 0, totalDamage = 0, kill = hp > 0 ? Infinity : 0;
    const casts: number[] = [];
    const done = () => time >= window && (!Number.isFinite(hp) || Number.isFinite(kill));
    const play = (stage: ElementStage, openingSkill: boolean) => {
      let left = stage.duration;
      if (stage.cast && !done()) casts.push(time);
      while (left > 1e-9 && !done()) {
        const burst = state.remaining > 0;
        const panel = time >= stableAfter && clock.count >= cap ? phases(stage)[burst ? 1 : 0] : panelAt(stage, clock.count, time, burst);
        if (preview && stackCap && !castStats && !stage.active) beforeCast = panel;
        const tick = clock.step(panel.components);
        const expiry = Math.min(...effects.timedStats.filter(stat => stat.until > time).map(stat => stat.until),
          effects.judgment && effects.judgment.until > time ? effects.judgment.until : Infinity);
        const step = advanceNecrosis(state, profile, rawRate(panel), Math.min(left, tick.seconds, expiry - time));
        const threshold = hp - dealt - (stage.executeBelow ?? 0);
        if (kill === Infinity && Number.isFinite(hp) && (threshold <= 0 || panel.dps > 0 && threshold / panel.dps <= step.seconds)) {
          kill = time + (threshold > 0 ? threshold / panel.dps : 0);
        }
        totalDamage += panel.dps * Math.min(Math.max(0, window - time), step.seconds);
        if (!Number.isFinite(step.seconds)) { time = Infinity; return; }
        if (openingSkill) collect(panel.components, step.seconds);
        dealt += panel.dps * step.seconds;
        left -= step.seconds; time += step.seconds;
        tick.advance(step.seconds);
        if (step.triggered && burstHit) {
          dealt += burstHit.perHit;
          if (time <= window) totalDamage += burstHit.perHit;
          if (kill === Infinity && dealt >= hp - (stage.executeBelow ?? 0)) kill = time;
          if (openingSkill) collect([burstHit], 0);
        }
      }
    };
    for (const stage of opening) {
      if (preview && stackCap && stage.cast && !castStats) castStats = panelAt(stage, clock.count, time, state.remaining > 0).stats;
      if (preview && stage.duration === Infinity) break;
      play(stage, preview && !!stage.active);
    }
    const afterOpening = dealt;
    for (let k = 0; repeat.length && !done(); k++) {
      const before = dealt, start = time;
      for (const stage of cycleStages(k, time)) play(stage, false);
      if (preview || time === start || (before === dealt && time >= Math.max(window, stableAfter))) break;
    }
    return { totalDamage, killTimeSec: kill, cycleDamage: dealt - afterOpening, casts };
  };
  const forever = opening.find(stage => stage.duration === Infinity);
  const finiteOpening = opening.slice(0, forever ? opening.indexOf(forever) : opening.length).reduce((sum, stage) => sum + stage.duration, 0);
  const repeatSeconds = repeat.reduce((sum, stage) => sum + stage.duration, 0);
  const preview = run(finiteOpening + (forever ? 0 : repeatSeconds), Infinity, true);
  let avgDps = repeatSeconds > 0 ? preview.cycleDamage / repeatSeconds : model.normal.dps;
  if (forever) {
    const [base, burst] = phases(forever), rate = rawRate(base) * profile.buildupMultiplier;
    const fill = rate > 0 ? profile.threshold / rate : Infinity;
    avgDps = Number.isFinite(fill) ? (base.dps * fill + burst.dps * profile.duration + (burstHit?.perHit ?? 0)) / (fill + profile.duration) : base.dps;
    if (forever.active && !skillSeconds) {
      if (Number.isFinite(fill)) { collect(base.components, fill); collect(burst.components, profile.duration); if (burstHit) collect([burstHit], 0); }
      else collect(base.components, 1);
    }
  }
  if (skillSeconds && model.skill) {
    const components = [...skillParts.values()].map(part => ({ ...part, dps: part.dps / skillSeconds, hitsPerSec: part.perHit ? part.dps / skillSeconds / part.perHit : 0 }));
    model.skill = { ...model.skill, components, dps: components.reduce((sum, part) => sum + part.dps, 0) };
  }
  model.elemental = { perSec: rawRate(model.normal) * profile.buildupMultiplier, note: (stackCap ? '部署时' : '') + '未爆发时的普攻损伤积累速率；损伤不扣血，爆发期间不再积累。' };
  // 补剂会在首开前改变面板。非技能分项取左极限，技能分项沿用首轮积分，面板取开技瞬间。
  if (beforeCast && castStats) model.normal = { ...model.normal, stats: beforeCast.stats, components: beforeCast.components };
  if (model.skill && castStats) model.skill = { ...model.skill, stats: castStats };
  model.notes.push('近似：模组损伤按各伤害段的期望速率连续积累。技能DPS取首轮，循环取其后的一个完整周期；永续阶段按完整元素周期结算。');
  // 首轮技能起止：第一个开技阶段的起点，到其后连续技能阶段的终点。
  const castIndex = opening.findIndex(stage => stage.cast);
  const firstStart = castIndex < 0 ? Infinity : opening.slice(0, castIndex).reduce((sum, stage) => sum + stage.duration, 0);
  let firstEnd = firstStart;
  for (let i = castIndex; i >= 0 && i < opening.length && opening[i]!.active && (i === castIndex || !opening[i]!.cast); i++) firstEnd += opening[i]!.duration;
  if (swift) model.notes.push(swiftNote);
  model.customTimeline = (duration, hp) => {
    const { totalDamage, killTimeSec } = run(duration, hp);
    return { totalDamage, killTimeSec, cycle: recovery === null ? null
      : { avgDps, spRecoverSec: recovery, skillDurationSec: model.duration }, notes: [], caveats: [],
      firstSkill: model.skill ? Number.isFinite(firstStart) ? { start: firstStart, end: firstEnd } : { start: Infinity, end: Infinity } : undefined,
      at: (t: number) => run(t, Infinity).totalDamage,
      castsUntil: [...opening, ...repeat].some(stage => stage.cast) ? (t: number) => run(t, Infinity).casts.filter(c => c <= t + 1e-9) : undefined };
  };
  return model;
}
