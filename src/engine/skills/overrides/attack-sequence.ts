import { swiftRefundSucceeds, Track, firstCrossing } from '../../swift.ts';
import { actionDamage, dotDps } from './shared.ts';
import type { GenericModel } from '../generic.ts';
import type { PhaseResult, SkillLevelData } from '../../types.ts';
import { segmentDamage, type Segment, type TimelineResult } from '../../timeline.ts';

export interface AttackClock {
  time: number; attacks: number; skillAttacks: number; casts: number; ends: number;
  lastCast: number; lastEnd: number; sp: number; active: boolean; cost: number; elementActive:boolean; counters:Record<string,number>; castTimes:readonly number[];
}
/** 同一组面板可重演多条战斗路径。回调的可变状态保存在传入的时钟上。 */
export interface AttackSequence {
  /** 对随受击时刻变化的护甲与暴击按命中结算；独立持续伤害仍按秒积分。 */
  discreteAttacks?: boolean;
  /** 自定义本次本体命中；延时段用 pulse 在实际命中时另计。 */
  shot?: (clock: AttackClock, phase: PhaseResult) => { damage:number; hits:number };
  attackReadyAt?: (clock:AttackClock) => number;
  immediateAttackRecovery?: boolean;
  castOnAttack?: boolean;
  select?: (clock: AttackClock) => PhaseResult;
  next?: (clock: AttackClock) => number;
  maxCasts?: number;
  afterPulse?: (clock:AttackClock) => void;
  onElement?: (clock:AttackClock) => void;
  pulse?: (clock:AttackClock) => { at:number; damage:number; hits?:number };
  element?: { threshold:number; duration:number; buildupMultiplier:number; burstDamage?:number; burstDps?:number;
    rate:(phase:PhaseResult, clock:AttackClock) => number };
  castDamage?: (clock: AttackClock) => number;
  endDamage?: (clock: AttackClock) => number;
}
type SequenceModel = GenericModel & { sequence?: AttackSequence };
/** 概率分支只查询一个窗口。保留施放历史供弹道使用，其他分段可立即积分并释放。 */
class DamageWindow {
  readonly casts: number[] = [];
  time = 0;
  damage = 0;
  readonly end: number;
  constructor(end: number) { this.end = end; }
  push(part: Segment) {
    if (part.cast && this.casts.at(-1) !== this.time) this.casts.push(this.time);
    if (this.time <= this.end + 1e-10) {
      const span = Math.max(0, Math.min(part.duration, this.end - this.time));
      this.damage += (part.burst ?? 0) + segmentDamage(part, span);
    }
    this.time += part.duration;
  }
}

/** 需要逐击判定的技能保留每次攻击、施放和结束时刻。通用面板重建接收同一份装备层数及目标减抗。 */
export function sequenceTimeline(model: SequenceModel, level: SkillLevelData): (duration: number, hp: number) => TimelineResult;
export function sequenceTimeline(model: SequenceModel, level: SkillLevelData, windowEnd: number): number;
export function sequenceTimeline(model: SequenceModel, level: SkillLevelData, windowEnd?: number) {
  const initial = model.battle!;
  const cost = Math.max(initial.spCostMin, level.spCost * initial.spCostScale);
  const capacity = cost * Math.max(1, level.maxChargeTime);
  const track = windowEnd === undefined ? new Track() : new DamageWindow(windowEnd);
  let buildup = 0, elementEnd = -Infinity;
  const state: AttackClock = { time:0, attacks:0, skillAttacks:0, casts:0, ends:0, lastCast:-Infinity,
    lastEnd:-Infinity, sp:Math.min(capacity, Math.max(0, level.initSp + initial.initSp)), active:false, cost, elementActive:false, counters:{}, castTimes:track.casts };
  const counts = initial.stacks.map(() => 0);
  let current = model, damageEvents = 0, progress = 0, remaining = 0, lockedUntil = 0;
  let nextSecond = 1, firstNormal: PhaseResult | undefined, firstActive: PhaseResult | undefined;
  let cacheKey = '', noFutureDamage = false, firstCastReachable = true;
  const damageEventLimit = Math.max(initial.resShred ? Math.ceil(initial.resShred.max / initial.resShred.perHit) : 0,
    initial.bondStacks ? Math.ceil(initial.bondStacks.max / initial.bondStacks.perDamage) : 0);
  const boundaries = [...initial.timedStats.map(s => s.until), ...(model.breakpoints ?? [])];
  if (initial.judgment) boundaries.push(initial.judgment.until);
  boundaries.sort((a, b) => a - b);
  let boundaryIndex = 0;
  const staticPanel = !damageEventLimit && !initial.stacks.length && !boundaries.length;
  const update = () => {
    if (!model.rebuild || (staticPanel && cacheKey)) return;
    const key = [Math.min(damageEvents, damageEventLimit), ...counts,
      ...initial.timedStats.map(s => +(s.until > state.time + 1e-9)), ...(model.breakpoints ?? []).map(t => +(t > state.time + 1e-9)),
      +(!!initial.judgment && initial.judgment.until > state.time + 1e-9)].join('/');
    if (key !== cacheKey) {
      current = model.rebuild(initial.stacks.map((s,i) => ({ ...s.modifier, value:s.modifier.value * counts[i]! })), state.time, damageEvents);
      cacheKey = key;
    }
  };
  const trigger = (event:'attack'|'skill'|'second') => initial.stacks.forEach((s,i) => {
    if (s.trigger === event) counts[i] = Math.min(s.max, counts[i]! + 1);
  });
  const selected = () => current.sequence?.select?.(state) ?? (state.active ? current.skill! : current.normal);
  let pendingAttack = false;
  let openingAttackDamage = 0;
  const settleAttack = (p:PhaseResult) => {
    const shot = current.sequence?.shot?.(state, p);
    const dealt = shot?.damage ?? (current.sequence?.discreteAttacks ? actionDamage(p) : 0);
    if (current.sequence?.discreteAttacks) track.push({ duration:0, dps:0, burst:dealt });
    state.attacks++; if (state.active) state.skillAttacks++;
    if (!state.active && level.spType === 'ON_ATTACK') state.sp = Math.min(capacity, state.sp + level.increment);
    if (shot) damageEvents += shot.hits;
    else {
      let hits = 0;
      for (const c of p.components) if (c.countsTowardDps && !c.source.startsWith('bond:') && !c.source.startsWith('equip:')) hits += c.hitsPerAttack;
      damageEvents += hits;
    }
    trigger('attack');
    return dealt;
  };
  const finish = () => {
    const bonus = current.sequence?.endDamage?.(state) ?? 0;
    track.push({ duration:0, dps:0, end:true, burst:bonus });
    state.active = false;
    state.lastEnd = state.time;
    const k = state.ends++;
    const { skillEndSp, skillEndProbability } = current.battle!;
    if (skillEndSp > 0 && swiftRefundSucceeds(k, skillEndProbability, state.time)) state.sp = Math.min(capacity, state.sp + skillEndSp);
  };
  const step = () => {
    update();
    if (state.active && remaining <= 1e-8) finish();
    const limit = current.sequence?.maxCasts ?? Infinity;
    const ready = current.skill && state.casts < limit && state.time + 1e-9 >= lockedUntil;
    if (!state.active && ready && state.sp >= cost - 1e-9 && (!current.sequence?.castOnAttack || pendingAttack)) {
      if (windowEnd === undefined) firstNormal ??= selected();
      state.casts++; state.lastCast = state.time; state.skillAttacks = 0; state.active = true;
      state.sp = Math.max(0, state.sp - cost);
      trigger('skill'); update();
      const cast = selected();
      firstActive ??= cast;
      remaining = current.duration;
      const burst = (current.burst ? actionDamage(cast) : 0) + (current.sequence?.castDamage?.(state) ?? 0);
      track.push({ duration:0, dps:0, cast:true, burst });
      if (current.burst && current.burstAttack) {
        state.attacks++; damageEvents += cast.components[0]?.hitsPerAttack ?? 0; trigger('attack');
      }
      if (remaining <= 1e-9) {
        finish();
        if (state.sp >= cost - 1e-9) lockedUntil = state.time + cast.stats.attackInterval;
        update();
      }
    }
    // 离散普通攻击与自动释放同一时刻就绪时，先结算技能及其减防，再让本次普攻击中。
    if (pendingAttack) {
      pendingAttack = false;
      const dealt = settleAttack(selected());
      update();
      if (current.sequence?.immediateAttackRecovery && !state.active && ready && state.sp >= cost - 1e-9) {
        if (state.casts === 0) openingAttackDamage = dealt;
        return;
      }
    }
    const p = selected();
    const interval = p.stats.attackInterval;
    const attacks = (p.components[0]?.hitsPerSec ?? 0) > 0 && p.components[0]?.damageType !== 'none';
    const rate = state.active ? 0 : level.spType === 'INCREASE_WITH_TIME' ? Math.max(0, level.increment + current.battle!.spRecovery) : 0;
    const skillReadyIn = !state.active && current.skill && state.casts < limit && rate > 0
      ? Math.max(lockedUntil - state.time, (cost - state.sp) / rate) : Infinity;
    const trait = current.sequence?.element;
    const accumulation = trait && !state.elementActive ? trait.rate(p,state) * trait.buildupMultiplier : 0;
    const pulse = current.sequence?.pulse?.(state);
    const attackReadyAt = current.sequence?.attackReadyAt?.(state) ?? -Infinity;
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex]! <= state.time + 1e-8) boundaryIndex++;
    const nextChange = Math.min(current.sequence?.next?.(state) ?? Infinity, boundaries[boundaryIndex] ?? Infinity,
      initial.stacks.some((s,i) => s.trigger === 'second' && counts[i]! < s.max) ? nextSecond : Infinity);
    if (!state.casts) {
      const canCharge = state.sp >= cost - 1e-9 || rate > 0 || (level.spType === 'ON_ATTACK' && level.increment > 0 && attacks);
      firstCastReachable = !!current.skill && limit > 0 && (Number.isFinite(nextChange)
        || (canCharge && (!current.sequence?.castOnAttack || attacks)));
    }
    const next = Math.min(pulse ? pulse.at - state.time : Infinity,
      state.elementActive ? elementEnd - state.time : accumulation > 0 ? (trait!.threshold - buildup) / accumulation : Infinity, attacks ? Math.max((1 - progress) * interval, attackReadyAt - state.time) : Infinity, state.active ? remaining : Infinity,
      skillReadyIn, nextChange - state.time);
    if (!(next > 1e-9)) throw new Error('逐击模型的下一事件未推进');
    const damageRate = current.sequence?.discreteAttacks ? dotDps(p) : p.dps;
    track.push({ duration:next, dps:damageRate + (state.elementActive ? trait?.burstDps ?? 0 : 0) });
    if (!Number.isFinite(next)) { noFutureDamage = p.dps === 0; state.time = Infinity; return; }
    state.time = track.time;
    if (pulse && Math.abs(state.time - pulse.at) <= 1e-8) {
      track.push({ duration:0, dps:0, burst:pulse.damage });
      damageEvents += pulse.hits ?? 0;
      current.sequence?.afterPulse?.(state);
    }
    if (trait) {
      if (state.elementActive) state.elementActive = state.time < elementEnd - 1e-8;
      else {
        buildup += next * accumulation;
        if (buildup >= trait.threshold - 1e-7) {
          buildup = 0; state.elementActive = true; elementEnd = state.time + trait.duration;
          current.sequence?.onElement?.(state);
          if (trait.burstDamage) track.push({ duration:0, dps:0, burst:trait.burstDamage });
        }
      }
    }
    if (state.active) remaining -= next;
    state.sp = Math.min(capacity, state.sp + rate * next);
    if (attacks) {
      progress = Math.min(1, progress + next / interval);
      if (progress >= 1 - 1e-8 && state.time >= attackReadyAt - 1e-8) {
        progress = 0;
        if (current.sequence?.discreteAttacks) pendingAttack = true;
        else settleAttack(p);
      }
    }
    if (state.time >= nextSecond - 1e-8) { trigger('second'); nextSecond = Math.floor(state.time + 1e-8) + 1; }
  };
  const ensure = (t:number) => { while (state.time <= t + 1e-8 && Number.isFinite(state.time)) step(); };
  if (track instanceof DamageWindow) {
    ensure(track.end);
    return track.damage;
  }
  const at = (t:number) => { ensure(t); return track.at(t); };
  return (duration:number, hp:number): TimelineResult => {
    ensure(duration);
    const totalDamage = track.at(duration);
    let kill = Infinity;
    if (Number.isFinite(hp)) {
      if (hp <= 0) kill = 0;
      else if (!noFutureDamage && (totalDamage > 0 || model.normal.dps || model.skill?.dps)) {
        // 短窗口可能刚好在首击之前。拿部署后前三分钟估速，避免为求零秒快照而直接模拟上百万秒。
        const sample = duration >= 180 ? totalDamage / duration : at(180) / 180;
        kill = firstCrossing(at, hp, hp / Math.max(1, sample));
      }
    }
    // 短窗口可能先于首次施放。取阶段快照时只推进到首开，已算出的窗口总伤保持在原查询时刻。
    // 能回复技力或有下一次面板变化时才继续；无法回复的干员即使一直普攻，也不会无限预读。
    while (!track.casts.length && firstCastReachable && Number.isFinite(state.time)) step();
    const first = track.casts[0] ?? Infinity;
    const cycle = track.casts.length > 1 ? { spRecoverSec:Math.max(0,track.casts[1]! - (track.ends[0] ?? first)),
      skillDurationSec:model.duration, avgDps:totalDamage / Math.max(1,duration) } : null;
    return { totalDamage, killTimeSec:kill, cycle, firstCast:first, firstSkill:{ start:first, end:track.ends[0] ?? first + model.duration, preCastDamage:openingAttackDamage },
      phases:{ normal:firstNormal, skill:firstActive }, at, castsUntil:t => { ensure(t); return track.casts.filter(x => x <= t + 1e-9); },
      endsUntil:t => { ensure(t); return track.ends.filter(x => x <= t + 1e-9); }, notes:[], caveats:[] };
  };
}

/** 弹体以各自的释放时刻起算，多个弹体同帧命中时合并本帧伤害。 */
export function skillPulse(s:AttackClock, interval:number, duration:number, damage:number, overlap = false) {
  let at = Infinity, amount = 0;
  for (let i=s.castTimes.length-1; i>=0; i--) {
    const start = s.castTimes[i]!;
    if (start + duration <= s.time + 1e-8) break;
    const tick = start + (Math.floor((s.time - start + 1e-8) / interval) + 1) * interval;
    if (tick <= start + duration + 1e-8) {
      if (tick < at - 1e-8) { at = tick; amount = damage; }
      else if (Math.abs(tick - at) < 1e-8) amount += damage;
    }
    if (!overlap) break;
  }
  return { at, damage:amount };
}
