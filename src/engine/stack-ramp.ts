import type { BattleEffects } from './effects/common.ts';
import type { GenericModel } from './skills/generic.ts';
import type { StatModifier } from './stats.ts';
import { leftLimit, timeline, type FirstSkill, type TimelineResult } from './timeline.ts';
import type { PhaseResult, SkillLevelData } from './types.ts';

/** 精建时间轴自行逐事件重算临时盟约层数的干员（其余精建只读部署时的静态效果）。 */
const tracksBondStacks = new Set(['char_4064_mlynar', 'char_4133_logos']);
/** 专属时间轴自行在到期时刻重建限时属性的干员（不需要按到期时刻分段）。 */
const tracksTimedStats = new Set(['char_4064_mlynar', 'char_1040_blaze2', 'char_1037_amiya3', 'char_1038_whitw2', 'char_4247_oxi',
  'char_4133_logos', 'char_4146_nymph', 'char_4145_ulpia', 'char_4193_lemuen', 'char_1046_sbell2']);
/** 分段数上限：超过时均匀抽取触发时刻，区间内取区间起点的层数（保守）。限时属性到期时刻始终保留。 */
const maxSteps = 24;
export const rampNote = '近似：专属模型的装备叠层、临时盟约层数与限时属性按触发时刻分段（开技叠层取拼接后的实际开技时刻；每秒、每次攻击、每次伤害按非技能期频率推算），区间内用区间起点的层数；断点处按所处回技或技能阶段的完成比例接续（继承剩余技力、攻击进度、技能剩余时间与迅捷判定序号），元素条等专属状态在断点按新层数的时间轴接续；来源：模型假设';

interface RampInput {
  external: BattleEffects;
  effectsAt: (damageEvents: number) => BattleEffects;
  build: (effects: BattleEffects) => GenericModel;
  level: SkillLevelData;
  model: GenericModel;
  operator: string;
  elementModule?: boolean;
}

export interface BondEventClock {
  /** 第 k 次（k 从 1 起）伤害事件的时刻。 */
  times: number[];
  /** [0, t] 内已发生的伤害事件数。 */
  countAt: (t: number) => number;
}

const attacking = (phase: PhaseResult | null) => phase?.components.some(c => c.countsTowardDps && c.hitsPerSec > 0 && c.source !== 'bond:kazimierzShip') ?? false;

/** 首次开技时刻的估算（专属时间轴未给出开技时刻时）：按初始技力与基础回复速度。 */
export function estimateFirstCast(external: BattleEffects, level: SkillLevelData, model: GenericModel) {
  const cost = Math.max(external.spCostMin, level.spCost * external.spCostScale);
  const recovery = level.spType === 'INCREASE_WITH_TIME' ? level.increment + external.spRecovery
    : level.spType === 'ON_ATTACK' && attacking(model.normal) ? 1 / model.normal.stats.attackInterval : 0;
  const need = Math.max(0, cost - level.initSp - external.initSp);
  return !model.skill ? Infinity : model.lifecycle === 'on_deploy' || need === 0 ? 0 : recovery > 0 ? need / recovery : Infinity;
}

/**
 * 「每次造成伤害」叠层（多功能补剂）的事件时刻：非技能期有攻击时按其频率，否则按技能期频率从首次开技起计。
 * 来源：模型假设（同一估算供分段重建与六人叙拉古逐跳层数共用）。
 */
export function bondEventClock(external: BattleEffects, model: GenericModel, firstCast: number): BondEventClock | undefined {
  const bond = external.bondStacks;
  if (!bond) return;
  const source = attacking(model.normal) ? model.normal : model.skill;
  const offset = source === model.normal ? 0 : firstCast;
  const hitsPerSec = source?.components.filter(c => c.countsTowardDps && !c.source.startsWith('bond:')).reduce((n, c) => n + c.hitsPerSec, 0) ?? 0;
  const events = Math.ceil(bond.max / bond.perDamage);
  const times: number[] = [];
  for (let k = 1; k <= events && hitsPerSec > 0 && Number.isFinite(offset); k++) times.push(offset + k / hitsPerSec);
  return { times, countAt: t => { let n = 0; while (n < times.length && times[n]! <= t + 1e-9) n++; return n; } };
}

/**
 * 精建模型不读 `e.stacks`（装备叠层）、`e.bondStacks`（多功能补剂）与限时属性到期时，在窗口里按真实触发过程分段：
 * 估算每个层数到达的时刻（开技叠层取拼接后时间轴的实际开技时刻），把各区间的层数与仍生效的限时属性作为静态属性重新构建精建模型，
 * 再按区间拼接累计伤害。区间断点上的瞬时伤害：开技触发的归入新区间，其余归入旧区间。
 *
 * 精建时间轴是黑盒，无法直接写入技力与攻击进度。各区间改为「按技能进度对齐」：把每个模型的时间过程看成交替的
 * 回技阶段与技能阶段（[0, 开技₀), [开技₀, 结束₀), [结束₀, 开技₁) …），断点处按旧模型所处阶段的完成比例，
 * 在新模型同一阶段的同一比例处接续。区间内属性不变，因此每个区间只是新模型时间轴的一个平移。
 * 这样剩余技力（回技阶段的完成比例）、攻击进度（攻击回复技力时同为完成比例）、技能剩余时间（技能阶段的完成比例，弹药技能随攻速缩放）
 * 与迅捷判定序号（阶段序号相同，第 k 次技能结束取第 k 次判定）都由前一区间继承，开技时刻随攻速叠层正确推迟或提前。
 * 来源：模型假设。
 */
export function stackRamp({ external, effectsAt, build, level, model, operator, elementModule }: RampInput) {
  const bond = !elementModule && !tracksBondStacks.has(operator) ? external.bondStacks : undefined;
  const timed = tracksTimedStats.has(operator) ? [] : [...new Set(external.timedStats.map(t => t.until).filter(t => Number.isFinite(t) && t > 0))];
  if (!external.stacks.length && !bond && !timed.length) return;
  const base = timeline(model, level, 180, Infinity);
  const firstCast = base.firstSkill?.start ?? base.firstCast ?? estimateFirstCast(external, level, model);
  const source = attacking(model.normal) ? model.normal : model.skill;
  const offset = source === model.normal ? 0 : firstCast;
  const attackInterval = source?.stats.attackInterval ?? Infinity;
  const eventTimes = (trigger: 'attack' | 'second', count: number) => {
    const times: number[] = [];
    for (let k = 1; k <= count; k++) {
      const t = trigger === 'second' ? k : offset + k * attackInterval;
      if (!Number.isFinite(t)) break;
      times.push(t);
    }
    return times;
  };
  const round = (t: number) => Math.round(t * 1e9) / 1e9;
  const stackTimes = external.stacks.map(s => s.trigger === 'skill' ? [] : eventTimes(s.trigger, s.max).map(round));
  const skillStacks = external.stacks.some(s => s.trigger === 'skill');
  const maxSkill = Math.min(maxSteps, Math.max(0, ...external.stacks.map(s => s.trigger === 'skill' ? s.max : 0)));
  const bondClock = bond ? bondEventClock(external, model, firstCast) : undefined;
  const bondTimes = bondClock?.times ?? [];
  let breaks = [...new Set([...stackTimes.flat(), ...bondTimes.map(round)].filter(t => Number.isFinite(t) && t > 0))].sort((a, b) => a - b);
  if (breaks.length > maxSteps) breaks = [...new Set(Array.from({ length: maxSteps }, (_, i) => breaks[Math.round(i * (breaks.length - 1) / (maxSteps - 1))]!))];
  breaks = [...new Set([...breaks, ...timed.map(round)])].sort((a, b) => a - b);
  const countAt = (times: number[], t: number) => times.filter(x => x <= t + 1e-9).length;
  // 只有限时属性到期时，分段拼接只在攻击回复技力（施放时刻随攻速变化）时近似。
  const approximate = external.stacks.length > 0 || !!bond || level.spType === 'ON_ATTACK';
  const notes = approximate ? [rampNote] : [];
  const cache = new Map<string, GenericModel>();
  const modelAt = (t: number, casts: number) => {
    const key = `${round(t)}/${casts}`;
    let m = cache.get(key);
    if (m) return m;
    const effects = bond ? effectsAt(bondClock!.countAt(t)) : external;
    const stats: StatModifier[] = external.stacks.flatMap((s, i) => {
      const n = s.trigger === 'skill' ? Math.min(s.max, casts) : countAt(stackTimes[i]!, t);
      return n ? [{ ...s.modifier, value: s.modifier.value * n }] : [];
    });
    m = build({ ...effects, stacks: [], bondStacks: bond ? undefined : effects.bondStacks, stats: [...effects.stats, ...stats],
      timedStats: timed.length ? effects.timedStats.filter(x => x.until > t + 1e-9) : effects.timedStats, notes: [...effects.notes, ...notes] });
    cache.set(key, m);
    return m;
  };
  const lastBreak = breaks.at(-1) ?? 0;
  const horizon = Math.max(180, 2 * lastBreak + 120);
  // 模型的阶段边界 [0, 开技₀, 结束₀, 开技₁, 结束₁, …]（偶数段为回技，奇数段为技能）。
  const bounds = new Map<GenericModel, { list: number[]; result: TimelineResult }>();
  const boundsOf = (m: GenericModel) => {
    let entry = bounds.get(m);
    if (entry) return entry;
    const result = timeline(m, level, horizon, Infinity);
    entry = { list: phaseBounds(m, result, horizon), result };
    bounds.set(m, entry);
    return entry;
  };
  interface Piece { start: number; model: GenericModel; shift: number; cast: boolean }
  const pieces: Piece[] = [{ start: 0, model: modelAt(0, 0), shift: 0, cast: false }];
  let casts = 0;
  for (let guard = 0; guard < 4 * maxSteps + 8; guard++) {
    const current = pieces.at(-1)!;
    const list = boundsOf(current.model).list;
    const next = breaks.find(b => b > current.start + 1e-9) ?? Infinity;
    let cast = Infinity;
    if (skillStacks && casts < maxSkill) {
      const tau = current.start + current.shift;
      const upcoming = list.find((b, i) => i % 2 === 1 && b > tau + 1e-9);
      if (upcoming !== undefined) cast = upcoming - current.shift;
    }
    const time = Math.min(next, cast);
    if (!Number.isFinite(time)) break;
    const atCast = cast <= next + 1e-9;
    if (atCast) casts++;
    const following = modelAt(time, casts);
    const tau = time + current.shift;
    const mapped = alignPhase(list, tau, boundsOf(following).list, atCast);
    pieces.push({ start: time, model: following, shift: mapped - time, cast: atCast || isCastBound(list, tau) });
  }
  const runCache = new Map<GenericModel, Map<number, number>>();
  const run = (m: GenericModel, t: number): number => {
    let c = runCache.get(m);
    if (!c) { c = new Map(); runCache.set(m, c); }
    let v = c.get(t);
    if (v === undefined) {
      const entry = boundsOf(m).result;
      v = entry.at && t <= horizon ? entry.at(t) : timeline(m, level, t, Infinity).totalDamage;
      c.set(t, v);
    }
    return v;
  };
  // 区间 j 起点在模型 j 时间轴上的累计值：开技断点取左极限（瞬时伤害归入新区间）。
  const edge = (j: number, k: number) => {
    const p = pieces[j]!, tau = pieces[k]!.start + p.shift;
    return pieces[k]!.cast ? leftLimit(t => run(p.model, t), tau) : run(p.model, tau);
  };
  const startValue = pieces.map((_, j) => j === 0 ? 0 : edge(j, j));
  const before: number[] = [0];
  for (let j = 1; j < pieces.length; j++) before.push(before[j - 1]! + edge(j - 1, j) - startValue[j - 1]!);
  const segmentAt = (t: number) => { let j = pieces.length - 1; while (j > 0 && pieces[j]!.start > t) j--; return j; };
  const at = (t: number) => { const j = segmentAt(t); return before[j]! + run(pieces[j]!.model, t + pieces[j]!.shift) - startValue[j]!; };
  // 拼接后的阶段边界（真实时刻），交替为开技、结束。
  const trueBounds = (t: number) => {
    const seen = new Map<number, number>();
    pieces.forEach((p, j) => {
      const end = j + 1 < pieces.length ? pieces[j + 1]!.start : Infinity;
      let list = boundsOf(p.model).list;
      if (!Number.isFinite(end) && t + p.shift > horizon) list = phaseBounds(p.model, timeline(p.model, level, t + p.shift, Infinity), t + p.shift);
      list.forEach((b, i) => {
        const time = b - p.shift;
        if (i > 0 && time <= t + 1e-9 && time >= p.start - 1e-9 && time < end - 1e-9 && !seen.has(i)) seen.set(i, time);
      });
    });
    return [...seen].sort((x, y) => x[0] - y[0]).map(([index, time]) => ({ index, time }));
  };
  const castsUntil = (t: number) => trueBounds(t).filter(b => b.index % 2 === 1).map(b => b.time);
  const endsUntil = (t: number) => trueBounds(t).filter(b => b.index % 2 === 0).map(b => b.time);
  const opening = trueBounds(horizon);
  const firstStart = opening.find(b => b.index === 1);
  const firstEnd = opening.find(b => b.index === 2);
  const firstSkill: FirstSkill | undefined = !model.skill ? undefined
    : firstStart ? { start: firstStart.time, end: firstEnd?.time ?? Infinity } : { start: Infinity, end: Infinity };
  const killAt = (hp: number) => {
    if (!Number.isFinite(hp)) return Infinity;
    for (let j = 0; j < pieces.length; j++) {
      const p = pieces[j]!;
      const start = p.start, end = j + 1 < pieces.length ? pieces[j + 1]!.start : Infinity;
      // 用本区间模型自身的时间轴求击杀（保留处决阈值等判定）：调整血量使区间起点的剩余血量与拼接曲线一致。
      const offsetHp = hp - before[j]! + startValue[j]!;
      const kill = timeline(p.model, level, Number.isFinite(end) ? end + p.shift : 180, offsetHp).killTimeSec - p.shift;
      if (kill < start - 1e-9) return start;
      if (kill < end) return kill;
    }
    return Infinity;
  };
  const castPiece = Number.isFinite(firstSkill?.start ?? Infinity) ? segmentAt(firstSkill!.start) : 0;
  const prePiece = Number.isFinite(firstSkill?.start ?? Infinity) ? segmentAt(firstSkill!.start - 1e-9) : 0;
  const phases = { normal: pieces[prePiece]!.model.normal, skill: pieces[castPiece]!.model.skill ?? undefined };
  return {
    phases,
    at,
    killAt,
    timeline: (duration: number, hp: number): TimelineResult => {
      const last = timeline(pieces.at(-1)!.model, level, duration, Infinity);
      return { ...last, totalDamage: at(duration), killTimeSec: killAt(hp), firstCast: firstSkill?.start ?? firstCast,
        castsUntil, endsUntil, firstSkill, at, notes: [...last.notes, ...notes] };
    },
  };
}

/** 时间过程的阶段边界：[0, 开技₀, 结束₀, 开技₁, …]。缺少结束标记时按首轮起止与模型时长推算。 */
export function phaseBounds(model: GenericModel, result: TimelineResult, horizon: number): number[] {
  const first = result.firstSkill;
  let casts = result.castsUntil?.(horizon) ?? [];
  if (!casts.length && first && Number.isFinite(first.start)) {
    casts = [first.start];
    const rest = result.cycle?.spRecoverSec, length = result.cycle?.skillDurationSec ?? model.repeatDuration ?? model.duration;
    if (rest !== undefined && Number.isFinite(rest + length) && rest + length > 0 && Number.isFinite(first.end)) {
      for (let c = first.end + rest; c <= horizon && casts.length < 10000; c += rest + length) casts.push(c);
    }
  }
  const ends = result.endsUntil?.(horizon);
  const list = [0];
  casts.forEach((c, k) => {
    const next = casts[k + 1] ?? Infinity;
    let end = k === 0 && first && Math.abs(first.start - c) <= 1e-7 ? first.end
      : ends?.find(e => e >= c - 1e-9) ?? c + (k ? model.repeatDuration ?? model.duration : model.duration);
    if (!(end >= c)) end = c;
    list.push(c, Math.min(end, next));
  });
  return list;
}
const isCastBound = (list: number[], tau: number) => list.some((b, i) => i % 2 === 1 && Math.abs(b - tau) <= 1e-7);
/** 把旧模型时间轴上 tau 所处阶段的完成比例映射到新模型同一阶段。atCast 表示 tau 恰为一次开技（取技能阶段的起点）。 */
export function alignPhase(from: number[], tau: number, to: number[], atCast: boolean): number {
  let i = 0;
  if (atCast) {
    const k = from.findIndex((b, j) => j % 2 === 1 && Math.abs(b - tau) <= 1e-7);
    i = k >= 0 ? k : 0;
  } else {
    for (let j = 0; j < from.length; j++) if (from[j]! <= tau + 1e-9) i = j;
  }
  if (i >= to.length) return tau;
  const oldLength = (from[i + 1] ?? Infinity) - from[i]!;
  const newLength = (to[i + 1] ?? Infinity) - to[i]!;
  const elapsed = Math.max(0, tau - from[i]!);
  if (Number.isFinite(oldLength) && Number.isFinite(newLength) && oldLength > 1e-12) return to[i]! + Math.min(1, elapsed / oldLength) * newLength;
  return to[i]! + (Number.isFinite(newLength) ? Math.min(elapsed, newLength) : elapsed);
}
