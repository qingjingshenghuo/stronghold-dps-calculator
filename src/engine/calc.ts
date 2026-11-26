import operatorsJson from '../data/generated/operators.json' with { type: 'json' };
import skillsJson from '../data/generated/skills.json' with { type: 'json' };
import bossesJson from '../data/generated/bosses.json' with { type: 'json' };
import bondsJson from '../data/generated/bonds.json' with { type: 'json' };
import equipsJson from '../data/generated/equips.json' with { type: 'json' };
import type { BondData, BossData, CalcInput, CalcResult, EquipData, OperatorData, SkillData } from './types.ts';
import { generic, staticRules } from './skills/generic.ts';
import { overrides } from './skills/overrides/index.ts';
import { battleEffects, type BattleEffects } from './effects/common.ts';
import { grantedSkillBonds } from './effects/granted-skill-bonds.ts';
import { applyBonds, memberBondIds } from './effects/bonds.ts';
import { applyEquips, combineEquips } from './effects/equips.ts';
import { equipCurve, timedDamageScaleAt } from './equip-curve.ts';
import { record } from './effects/common.ts';
import { applyGarrisons } from './effects/garrisons.ts';
import { combatTarget } from './damage.ts';
import { firstSkillAt, leftLimit, tickCount, timeline } from './timeline.ts';
import { damage } from './damage.ts';
import { firstCrossing, swiftDraw, swiftReadCount, withExpectedRenewals, withSwiftPath } from './swift.ts';
import { swiftExpectation } from './swift-expectation.ts';
import { kazimierzSource } from './effects/skill-bonds.ts';
import { bondEventClock, estimateFirstCast, stackRamp } from './stack-ramp.ts';
import { resolveOperatorState } from './operator-state.ts';
import { bossAttackInterval } from './effects/boss-attack.ts';
const operators = new Map((operatorsJson as unknown as OperatorData[]).map(o => [o.charId, o]));
const bosses = new Map((bossesJson as BossData[]).map(b => [b.bossId, b]));
const skills = skillsJson as unknown as Record<string, SkillData>;
const bonds = new Map((bondsJson as BondData[]).map(b => [b.bondId, b]));
const equips = new Map((equipsJson as EquipData[]).map(e => [e.chessId, e]));
function memo(at: (t: number) => number): (t: number) => number {
  const cache = new Map<number, number>();
  return t => { let v = cache.get(t); if (v === undefined) { v = at(t); cache.set(t, v); } return v; };
}
/**
 * 叠加伤害（竞技旗倍率、灼燃、六人叙拉古跳伤）后的击杀用时。原时间轴没有提前击杀（处决）时，直接求叠加曲线越过血量的时刻；
 * 有处决时，按「t 时刻的叠加伤害 E(t) 预先扣除」后的剩余血量沿用原时间轴的击杀判定：最早满足 原轴击杀用时(血量 − E(t)) ≤ t 的 t。
 */
function overlayKill(curve: (t: number) => number, raw: (t: number) => number, killAt: (h: number) => number, baseKill: number, hp: number, rate: number) {
  if (!Number.isFinite(hp)) return Infinity;
  const guess = Math.min(Number.isFinite(baseKill) ? baseKill : Infinity, hp / Math.max(rate, 1e-9));
  if (!Number.isFinite(baseKill) || raw(baseKill) >= hp * (1 - 1e-9)) return firstCrossing(curve, hp, Number.isFinite(guess) ? guess : 1);
  const done = (t: number) => killAt(Math.max(0, hp - (curve(t) - raw(t)))) <= t + 1e-9;
  if (done(0)) return 0;
  let lo = 0, hi = baseKill;
  for (let i = 0; i < 60 && hi - lo > 1e-7; i++) { const mid = (lo + hi) / 2; if (done(mid)) hi = mid; else lo = mid; }
  return hi;
}
interface SwiftWindow {
  casts: number;
  staticSwift: boolean;
  replay?: () => number;
  exactDamage?: () => number;
  endTimes: Map<number, number>;
}

export function calculate(input: CalcInput): CalcResult {
  const setting = Array.isArray(input.bonds) && input.bonds.find(b => b.bondId === 'swiftShip' && b.activeChars >= bonds.get('swiftShip')!.activeCount);
  if (!setting) return simulate(input, false);
  const window: SwiftWindow = { casts: 0, staticSwift: false, endTimes: new Map() };
  let drew = false;
  const result = withSwiftPath((k, p, t) => {
    drew = true;
    if (t !== undefined && t <= 180 + 1e-8) window.endTimes.set(k, t);
    return swiftDraw(k) < p;
  }, () => simulate(input, false, window));
  if (!drew) return result;
  const describe = (message: string) => {
    result.assumptions = [...result.assumptions ?? [], '【迅捷】' + message];
    result.notes.push('近似：迅捷' + message);
    result.accuracy = 'approx';
  };
  if (window.casts > 10) {
    describe('180秒内开技超过10次，按固定序列逐次判定回技，取窗口实际平均伤害。');
    return result;
  }
  const horizon = result.totalDamage.durationSec;
  if (!horizon) return result;
  const run = window.replay ?? (() => simulate(input, true));
  const expectation = window.exactDamage
    ? { damage: window.exactDamage(), sampled: false }
    : swiftExpectation(horizon, window.staticSwift && horizon <= 180 ? () => withExpectedRenewals(run) : run);
  result.totalDamage.value = expectation.damage;
  if (result.cycle) result.cycle.avgDps = expectation.damage / horizon;
  describe('180秒内开技至多10次，按整笔回技成功或失败的概率计算窗口伤害。' +
    (expectation.sampled ? '连续回技使部分分支超过10次判定，后续按四条分层轨迹估算。' : '') + '击杀用时取代表战斗。');
  return result;
}

function simulate(input: CalcInput, windowOnly: true, window?: SwiftWindow): number;
function simulate(input: CalcInput, windowOnly: false, window?: SwiftWindow): CalcResult;
function simulate(input: CalcInput, windowOnly: boolean, window?: SwiftWindow): CalcResult | number {
  const dataOperator = operators.get(input.charId);
  if (!dataOperator) throw new RangeError(`未知干员：${input.charId}`);
  if (input.tier !== 'a' && input.tier !== 'b') throw new RangeError(`未知阶级：${input.tier}`);
  const { operator, tier, baseAtk, steps } = resolveOperatorState(dataOperator, input);
  const skill = skills[input.skillId];
  if (!operator.skillIds.includes(input.skillId) || !skill) throw new RangeError(`干员无此技能：${input.skillId}`);
  const level = skill.levels[String(tier.skillLevel)];
  if (!level) throw new RangeError(`缺少技能等级：${input.skillId}/${tier.skillLevel}`);
  const data = bosses.get(input.bossId);
  const boss = data && combatTarget(data, input.bossMechanics);
  const targetHp = boss?.hpByMode[input.modeId];
  if (!boss || targetHp === undefined || !Number.isFinite(targetHp) || targetHp <= 0) throw new RangeError(`未知Boss或规程血量：${input.bossId}/${input.modeId}`);
  const hp = windowOnly ? Infinity : targetHp;
  // 计算窗口：缺省 180 秒（循环平均 = 窗口总伤 ÷ 窗口时长）。
  const durationSec = input.durationSec ?? 180;
  if (!Number.isFinite(durationSec) || durationSec < 0) throw new RangeError('时长必须为有限非负数');
  if (!Array.isArray(input.equips) || input.equips.some(id => !equips.has(id))) throw new RangeError('装备不存在');
  if (!Array.isArray(input.bonds)) throw new RangeError('盟约配置必须为数组');
  if (input.fieldHammers !== undefined && (!Array.isArray(input.fieldHammers) || input.fieldHammers.some(name => typeof name !== 'string'))) throw new RangeError('场上维式重锤必须为装备名数组');
  for (const setting of input.bonds) {
    if (!bonds.has(setting.bondId) || !Number.isInteger(setting.stacks) || setting.stacks < 0 || !Number.isInteger(setting.activeChars) || setting.activeChars < 0) throw new RangeError('盟约不存在或层数/人数无效');
  }
  const external = battleEffects();
  // 同时携带可组合的两件装备时，按游戏规则组合成一件再计算（成员身份、维多利亚装备件数都按组合后计）。
  const { equips: selected, combined } = combineEquips(input.equips.slice(0, tier.equipSlotNum).map(id => equips.get(id)!));
  if (input.equips.length > tier.equipSlotNum) external.notes.push(`装备槽数超过${tier.equipSlotNum}，只取前${tier.equipSlotNum}件`);
  for (const c of combined) {
    record(external, `equip:${c.to.chessId}`, `${c.from.join(' 与 ')} 同时携带，组合为 ${c.to.name}`, 1);
    external.assumptions.push(`【${c.to.name}】${c.from.join('与')}同时携带，组合为${c.to.name}计算`);
  }
  const settings = [...new Map(input.bonds.map(b => [b.bondId, b])).values()];
  if (settings.length !== input.bonds.length) external.notes.push('重复盟约配置仅取最后一项，不重复叠加');
  applyBonds(external, [...bonds.values()], settings, operator, tier, selected);
  const membership = new Set(memberBondIds(operator, selected.map(equip => equip.chessId), selected));
  const activeBonds = settings.filter(s => s.activeChars >= bonds.get(s.bondId)!.activeCount);
  const activeMemberBonds = new Set(activeBonds.map(s => s.bondId).filter(id => membership.has(id)));
  const equipContext = (bondSettings: typeof settings) => ({
    boss, bonds: bondSettings, memberBondIds: [...membership], hasActiveMemberBond: activeMemberBonds.size > 0,
    fieldHammers: input.fieldHammers, targetDistance: operator.charId === 'char_4177_brigid' ? 1 : undefined });
  const moduleId = input.tier === 'b' ? tier.uniEquipId : null;
  const elementModule = moduleId === 'uniequip_002_logos' || moduleId === 'uniequip_003_thorns';
  const supplements = elementModule ? selected.filter(item => item.name === '多功能补剂') : [];
  const initialEquipContext = equipContext(settings);
  const otherEquips = supplements.length ? selected.filter(item => !supplements.includes(item)) : selected;
  applyEquips(external, otherEquips, activeBonds.length, initialEquipContext);
  applyGarrisons(external, tier.garrisonIds, settings);
  if (supplements.length) {
    if (activeMemberBonds.size && (external.stacks.length || external.timedStats.length)) {
      const reason = '另一组属性也随战斗时间变化，保留输入的盟约层数、装备属性进度与元素模组，仅忽略多功能补剂在战斗中新增的盟约层数';
      record(external, `equip:${supplements[0]!.chessId}`, reason, 0);
      external.notes.push(`近似：${reason}`);
      external.assumptions.push(`【多功能补剂】${reason}`);
    } else applyEquips(external, supplements, activeBonds.length, initialEquipContext);
  }
  const fallback = moduleId === 'uniequip_003_dusk' ? 'SPC-Y 的第二只小自在取决于相邻可部署格，召唤数量、命中与逐只回技均不能由单目标输入确定' : undefined;
  if (fallback) external.notes.push(`近似：${fallback}；本组合退回通用模型，未计专属时间轴。`);
  const override = fallback ? undefined : overrides[operator.charId];
  const effectsAt = (damageEvents: number) => {
    const effect = external.bondStacks;
    if (!effect) return external;
    const extra = Math.min(effect.max, damageEvents * effect.perDamage);
    const updated = settings.map(s => activeMemberBonds.has(s.bondId) ? { ...s, stacks: s.stacks + extra } : s);
    const effects = battleEffects();
    applyBonds(effects, [...bonds.values()], updated, operator, tier, selected);
    applyEquips(effects, selected, activeBonds.length, equipContext(updated));
    applyGarrisons(effects, tier.garrisonIds, updated);
    // 战斗叠层不能补发部署属性或延长其持续时间。
    effects.timedStats = external.timedStats;
    if (effects.judgment && external.judgment) effects.judgment.until = external.judgment.until;
    return effects;
  };
  // 受击回复技力：默认 Boss 一直攻击该干员，每受一次攻击回复 increment 点技力，按 Boss 攻击间隔折成连续速率交给时间轴。
  // 时间轴对自然回复类技能会再加上技力自然回复加成（如萨尔贡浓茶）；受击回复不吃该加成，折算时先扣掉。
  let spLevel = level;
  let defendNote: string | undefined;
  if (level.spType === 'ON_DEFEND') {
    const attack = bossAttackInterval(boss);
    const perSec = Math.max(0, level.increment) / attack.interval;
    spLevel = { ...level, spType: 'INCREASE_WITH_TIME', increment: perSec - external.spRecovery };
    record(external, `boss:${boss.bossId}`, `受击回复技力：默认 Boss 持续攻击该干员，每 ${+attack.interval.toFixed(4)} 秒受击一次（${attack.source}），每次 +${level.increment} 技力，折合每秒回复`, perSec);
    defendNote = `近似：默认 Boss 自部署起每 ${+attack.interval.toFixed(4)} 秒命中一次，每次受击回复 ${level.increment} 点，技力锁定期间的受击跳过。未计 Boss 技能或转移目标（${attack.source}）。`;
    external.assumptions.push('【受击回复】默认 Boss 持续攻击该干员，按 Boss 攻击间隔回复技力');
  }
  if (window) window.staticSwift = selected.length === 0 && settings.every(s => s.bondId === 'swiftShip' || s.bondId === 'maniShip' || s.activeChars < bonds.get(s.bondId)!.activeCount);
  const context = { operator, tier, skill, level, boss, targetHp, effectsAt, cultivation: input.cultivation, staticSwift: window?.staticSwift };
  const prepared = staticRules(operator, tier, skill, level);
  const build = (effects: BattleEffects, at = effectsAt) => {
    const make = (battle: BattleEffects, events: typeof effectsAt) => {
      const base = generic(operator, tier, skill, level, boss, battle, prepared);
      const model = override ? override({ ...context, effectsAt: events }, base) : base;
      if (level.spType === 'ON_DEFEND') model.defendSp = { interval:bossAttackInterval(boss).interval, gain:level.increment };
      return model;
    };
    const full = make(effects, at);
    // 卡西米尔附带真伤按窗口叠加在精建轴上；玛恩纳三个技能都在开技窗口内且非技能期不攻击，由精建直接计入。
    const kaz = !!effects.kazimierz && operator.charId !== 'char_4064_mlynar';
    if (!override || !kaz && !effects.quicksand) return full;
    const without = (battle: BattleEffects) => ({ ...battle, kazimierz: kaz ? undefined : battle.kazimierz, quicksand: undefined });
    return grantedSkillBonds(full, effects, context, kaz, () => make(without(effects), count => without(at(count))));
  };
  const beforeBuild = swiftReadCount();
  const model = build(external);
  const reusablePanels = model.nativeRotation && !model.customTimeline && swiftReadCount() === beforeBuild;
  if (external.bondStacks && !model.nativeRotation) {
    model.rebuild = (stackStats, elapsed, damageEvents) => {
      const effects = effectsAt(damageEvents);
      const next = build(effects);
      return next.rebuild?.(stackStats, elapsed, damageEvents) ?? next;
    };
  }
  // 精建时间轴不读装备叠层、临时盟约层数与限时属性到期时，按触发时刻分段换用对应的静态面板。
  const ramp = override && !model.nativeRotation ? stackRamp({ external, effectsAt, build, level: spLevel, model, operator: operator.charId, elementModule }) : undefined;
  let process = ramp ? ramp.timeline(durationSec, hp) : timeline(model, spLevel, durationSec, hp);
  if (ramp) process.phases = ramp.phases;
  if (window && !windowOnly && external.skillEndSp > 0 && external.skillEndProbability < 1) {
    const classification = durationSec === 180 || process.castsUntil ? process :
      ramp ? ramp.timeline(180, Infinity) : timeline(model, spLevel, 180, Infinity);
    const casts = classification.castsUntil?.(180);
    if (casts !== undefined) window.casts = casts.length;
    else {
      const first = classification.firstSkill?.start ?? classification.firstCast ?? estimateFirstCast(external, spLevel, model);
      const interval = classification.cycle ? classification.cycle.spRecoverSec + classification.cycle.skillDurationSec : Infinity;
      window.casts = first > 180 ? 0 : 1 + (interval > 0 ? Math.floor((180 - first) / interval) : 0);
      if (window.endTimes.size) {
        const ends = Math.max(...window.endTimes.keys()) + 1;
        window.casts = Math.max(ends, Math.min(ends + 1, window.casts));
      }
    }
    // 逐路径仅查询窗口总伤；静态输入和技能规则只解析一次，独立施放状态每次重新建立。
    if (!ramp && !external.judgment && !external.periodic.length && !external.burning &&
        !external.timedDamageScale.length && !external.bondStacks) {
      if (model.expectedSwiftDamage && durationSec <= 180) window.exactDamage = () => model.expectedSwiftDamage!(durationSec);
      if (model.replayDamage) window.replay = () => model.replayDamage!(durationSec);
      else {
        if (reusablePanels && model.rebuild) {
          const rebuild = model.rebuild;
          const panels = new Map<string, ReturnType<typeof rebuild>>();
          model.rebuild = (stats, time, events) => {
            const key = [time, events, ...stats.map(s => s.value)].join('/');
            const previous = panels.get(key);
            if (previous) return previous;
            const before = swiftReadCount();
            const panel = rebuild(stats, time, events);
            if (swiftReadCount() === before) panels.set(key, panel);
            return panel;
          };
        }
        window.replay = () => timeline(reusablePanels ? model : build(external), spLevel, durationSec, Infinity).totalDamage;
      }
    }
  }
  // 原时间轴在给定 Boss 血量下的击杀用时（保留处决阈值等判定）；叠加的伤害曲线按调整后的剩余血量沿用它。
  let killAt = (h: number) => ramp ? ramp.killAt(h) : timeline(model, spLevel, durationSec, h).killTimeSec;
  // 累计伤害曲线（不计击杀）：总伤、击杀、阶段区间都从同一条曲线读取，断点值缓存复用。
  // 时间轴已给出可直接查询的曲线且与窗口总伤一致时直接使用，不再按窗口重新求时间过程。
  const direct = !ramp && process.at && Math.abs(process.at(durationSec) - process.totalDamage) <= 1e-6 * Math.max(1, Math.abs(process.totalDamage)) ? process.at : undefined;
  let raw = memo(ramp ? ramp.at : direct ?? ((t: number) => timeline(model, spLevel, t, Infinity).totalDamage));
  // 异构体取得叙拉古身份后，部分精建技能用部署快照构造独立循环。
  // 在原技能轴（含迅捷分支）上结算窗口，之后只把已造成的伤害从 Boss 剩余血量中扣一次。
  if (external.judgment && override && operator.charId !== 'char_1038_whitw2' && (model.customTimeline || !model.rebuild)) {
    model.notes.push('近似：装备授予叙拉古身份时，裁度沿用此技能时间轴的本体攻击动作；连续伤害阶段按攻击频率积分，离散攻击按事件结算。');
    const until = external.judgment.until;
    const without = { ...external, judgment: undefined };
    const baseEffects = (count: number) => ({ ...effectsAt(count), judgment: undefined });
    const baseline = build(without, baseEffects);
    const baseRamp = stackRamp({ external: without, effectsAt: baseEffects, build: effects => build(effects, baseEffects), level: spLevel, model: baseline, operator: operator.charId, elementModule });
    const baseAt = memo(baseRamp ? baseRamp.at : (t: number) => timeline(baseline, spLevel, t, Infinity).totalDamage);
    const withJudgment = raw;
    const bonus = withJudgment(until) - baseAt(until);
    const after = (h: number) => baseRamp ? baseRamp.timeline(durationSec, h) : timeline(baseline, spLevel, durationSec, h);
    killAt = h => {
      const atEnd = durationSec === until && h === hp ? process.killTimeSec : ramp ? ramp.killAt(h) : timeline(model, spLevel, until, h).killTimeSec;
      return atEnd <= until ? atEnd : after(Math.max(0, h - bonus)).killTimeSec;
    };
    const killTimeSec = killAt(hp);
    raw = memo(t => t <= until ? withJudgment(t) : baseAt(t) + bonus);
    process = { ...process, cycle: after(Math.max(0, hp - bonus)).cycle, totalDamage: raw(durationSec), killTimeSec };
  }
  // 自定义轴的循环是稳态量；从零层部署的窗口和击杀过程不能用稳态面板替换。
  if (!windowOnly && override && model.customTimeline && external.resShred && process.cycle && process.cycle.avgDps > 0
      && operator.charId !== 'char_180_amgoat' && operator.charId !== 'char_4133_logos') {
    const saturated = { ...external, judgment: undefined, resShred: undefined, resReductionFixed: external.resReductionFixed + external.resShred.max };
    const steady = build(saturated);
    process.cycle = timeline(steady, spLevel, durationSec, Infinity).cycle;
  }
  // 第一轮技能的实际起止：由时间轴直接给出；未给出时按首次开技时刻与模型首轮时长。
  const firstSkill = process.firstSkill ?? (model.skill
    ? firstSkillAt(process.firstCast ?? estimateFirstCast(external, spLevel, model), model.duration) : undefined);
  const firstCast = firstSkill?.start;
  // 竞技旗倍率与灼燃条随时间变化：叠加在累计伤害曲线上，重算窗口总伤与击杀用时。
  let curveAt = raw;
  const timed = equipCurve({ external, boss, model, cycle: process.cycle, raw, durationSec, operator: operator.charId });
  if (timed) {
    curveAt = timed.at;
    if (timed.at !== raw) process = { ...process, totalDamage: process.totalDamage + timed.at(durationSec) - raw(durationSec) };
    process.notes = [...process.notes, ...timed.notes];
    external.assumptions.push(...timed.assumptions);
  }
  // 六人叙拉古等与动作无关的固定间隔伤害：叠加在时间轴之上，并作为分项列入两个阶段。
  // 每跳按当时的有效层数结算（多功能补剂等临时层数随伤害事件增加），干员退场后停止。
  const leavesAt = model.leavesAt ?? Infinity;
  const stackClock = external.bondStacks ? bondEventClock(external, model, firstCast ?? estimateFirstCast(external, spLevel, model)) : undefined;
  const periodicHit = (p: BattleEffects['periodic'][number]) =>
    // 模型假设：异常状态真伤只受目标侧脆弱与 Boss 机制影响，不吃干员自身增伤。
    damage({ attack: p.damage, type: p.type, target: boss, modifiers: external.modifiers.filter(m => m.kind === 'fragile') });
  const periodic = external.periodic.map((p, index) => {
    const hit = periodicHit(p);
    // 层数变化点（伤害事件时刻）上的每跳伤害；之后层数不再变化。
    const levels = (stackClock?.times ?? []).map((time, k) => {
      const updated = effectsAt(k + 1).periodic[index];
      return { time, perHit: updated ? periodicHit(updated).perHit : hit.perHit };
    });
    const ticks = (t: number) => tickCount(Math.min(t, leavesAt), p.interval, p.interval);
    // [0, t] 内的跳伤总和：按层数变化点分段计数。
    const extra = (t: number) => {
      const n = ticks(t);
      let sum = 0, done = 0, perHit = hit.perHit;
      for (const step of levels) {
        const upto = Math.min(n, tickCount(step.time - 1e-9, p.interval, p.interval));
        if (upto > done) { sum += (upto - done) * perHit; done = upto; }
        perHit = step.perHit;
        if (done >= n) break;
      }
      return sum + Math.max(0, n - done) * perHit;
    };
    return { ...p, extra, component: { label: p.label, source: p.source, damageType: p.type, perHit: hit.perHit, hitsPerAttack: 1,
      hitsPerSec: 1 / p.interval, dps: hit.perHit / p.interval, countsTowardDps: true,
      derivation: [{ label: '每次结算基础伤害', value: p.damage, op: 'set' as const, source: p.source }, ...hit.derivation.slice(3),
        { label: '结算间隔（秒）', value: p.interval, op: 'info' as const, source: p.source }] } };
  });
  if (periodic.length) {
    const extra = (t: number) => periodic.reduce((sum, p) => sum + p.extra(t), 0);
    const base = curveAt;
    curveAt = (t: number) => base(t) + extra(t);
    process = { ...process, totalDamage: process.totalDamage + extra(durationSec) };
    if (Number.isFinite(leavesAt)) process.notes = [...process.notes, '近似：干员退场后不再在场，六人叙拉古每秒真伤随之停止；来源：盟约描述「在场」条件'];
    if (stackClock) process.notes = [...process.notes, '近似：六人叙拉古每秒真伤按当时的有效层数结算，临时层数的到达时刻按伤害事件频率推算；来源：模型假设'];
  }
  if (windowOnly) return process.totalDamage;
  if (curveAt !== raw) {
    const rate = periodic.reduce((sum, p) => sum + p.component.dps, 0) + (process.cycle?.avgDps ?? model.normal.dps);
    process = { ...process, killTimeSec: overlayKill(curveAt, raw, killAt, process.killTimeSec, hp, rate) };
  }
  // 面板快照：非技能期取第一次开技能前一刻，技能期取第一次开技能时（时间过程给出时）。
  let normal = process.phases?.normal ?? model.normal;
  let skillPhase = model.skill ? process.phases?.skill ?? model.skill : null;
  const kazimierz = external.kazimierz;
  if (kazimierz && (!override || model.nativeRotation) && firstCast !== undefined && firstCast >= kazimierz.duration) {
    // 部署后的附带真伤窗口在首次开技前已经结束。
    const dropped = normal.components.filter(c => c.source === kazimierzSource);
    if (dropped.length) normal = { ...normal, components: normal.components.filter(c => c.source !== kazimierzSource), dps: normal.dps - dropped.reduce((n, c) => n + c.dps, 0) };
  }
  const withPeriodic = (phase: typeof normal) => periodic.length ? { ...phase, components: [...phase.components, ...periodic.map(p => p.component)],
    dps: phase.dps + periodic.reduce((sum, p) => sum + p.component.dps, 0) } : phase;
  normal = withPeriodic(normal);
  skillPhase = skillPhase && withPeriodic(skillPhase);
  // 阶段 DPS 取同一条累计伤害曲线（含六人叙拉古真实跳伤、竞技旗与灼燃）的区间差分，区间均为左闭右开：
  // 非技能期 = [0, 开技) 的伤害 ÷ 时长（含部署瞬间的伤害）；技能期 = [开技, 首轮结束) 的伤害 ÷ 时长。
  // 开技同一时刻的瞬时伤害归技能期；首轮结束同一时刻的伤害归之后的非技能期。
  // 面板属性与分项保留快照（开技前一刻 / 开技时）。无技能、从不开技、常驻与瞬发技能保持快照口径。
  if (firstSkill && Number.isFinite(firstSkill.start) && model.skill) {
    // 给足最后一点攻击技力的普攻先命中、随后才开技；即使同帧，仍属普通阶段。
    const openingScale = timedDamageScaleAt(external.timedDamageScale, firstSkill.start);
    const before = leftLimit(curveAt, firstSkill.start) + (firstSkill.preCastDamage ?? 0) * openingScale;
    if (firstSkill.start > 1e-9) normal = { ...normal, dps: Math.max(0, before / firstSkill.start) };
    const length = firstSkill.end - firstSkill.start;
    if (skillPhase && model.lifecycle !== 'instant' && length > 1e-9 && Number.isFinite(length)) {
      const endDamage = firstSkill.includesEndHit ? curveAt(firstSkill.end) : leftLimit(curveAt, firstSkill.end);
      skillPhase = { ...skillPhase, dps: Math.max(0, (endDamage - before) / length) };
    }
  }
  // 循环平均 = 窗口内总伤 ÷ 窗口时长。一次性技能（只开一次）没有循环，保持 null。
  let cycle = process.cycle;
  if (cycle && durationSec > 0) cycle = { ...cycle, avgDps: process.totalDamage / durationSec };
  if (steps.length) {
    // 部分技能与普攻共用同一面板；只展开一次基础攻击，后面的天赋、盟约和技能乘区沿用原推导。
    for (const atk of new Set([normal.stats.derivation.atk, skillPhase?.stats.derivation.atk])) {
      if (!atk) continue;
      if (steps.some(step => step.source !== tier.uniEquipId)) atk[0] = { ...atk[0]!, value: baseAtk };
      atk.splice(1, 0, ...steps);
    }
  }
  // 分段重建已覆盖装备叠层与限时属性到期时，去掉专属模型“按部署值计算”的旧说明。
  const superseded = (n: string) => n.includes('尚未逐事件重建') || /^近似：(限时外部属性|外部限时属性|限时装备属性|限时外部面板)/.test(n);
  const notes = [...model.notes.filter(n => !ramp || !superseded(n)), ...process.notes, ...defendNote ? [defendNote] : []];
  const caveats = [...model.caveats, ...process.caveats];
  if (!boss.attributes) caveats.push('近似：Boss属性缺失，防御/法抗暂按0计算');
  if (!boss.verified) caveats.push('忽略了 Boss关卡未核实的属性修饰器与数据不确定性（机制）');
  for (const mechanic of boss.mechanics ?? []) {
    if (!mechanic.effect) caveats.push(mechanic.desc);
    if ((input.bossMechanics?.[mechanic.id] ?? mechanic.defaultOn) && /近似|未确认/.test(mechanic.desc)) notes.push(mechanic.desc);
  }
  const assumptions = [...new Set([...external.assumptions, ...model.assumptions ?? []])];
  return { input, normal, skill: skillPhase, lifecycle: model.lifecycle, cycle, assumptions,
    totalDamage: { durationSec, value: process.totalDamage }, killTimeSec: process.killTimeSec,
    elemental: model.elemental ?? null, caveats: [...new Set(caveats)], ignoredKeys: [...new Set(model.ignoredKeys)], accuracy: notes.length ? 'approx' : 'exact', notes: [...new Set(notes)], model: override ? 'override' : 'generic' };
}
