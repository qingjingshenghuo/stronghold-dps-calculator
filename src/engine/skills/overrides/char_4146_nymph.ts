import { swiftLockNote, swiftNote, swiftRefundSucceeds } from '../../swift.ts';
import { swiftRecovery } from './swift.ts';
import { isDotSource } from '../../effects/skill-bonds.ts';
import { swiftRenewal } from '../../swift.ts';
import { ShredClock } from '../../effects/shred-clock.ts';
import type { DamageComponent, PhaseResult } from '../../types.ts';
import { battleEffects } from '../../effects/common.ts';
import { advanceNecrosis, necrosisProfile } from '../../effects/elemental.ts';
import { artsFraction } from '../../damage.ts';
import { arcaneOnly, overrideBase, phase } from './shared.ts';
import type { SkillOverride } from './index.ts';

// PRTS https://prts.wiki/w/妮芙（技能备注亦见 https://prts.wiki/w/ニンフ）：
// S2本体与0.33秒后溅射都命中主目标，每段先法伤、再损伤、再施加高倍率失魂；取最高不叠加。
export const nymphOverride: SkillOverride = (context, generic) => {
  const { tier, level, skill, boss } = context;
  const base = overrideBase(generic), e = generic.battle ?? battleEffects();
  const bb = level.blackboard.nums, talent = tier.talents[0]!.blackboard.nums, stacksTalent = tier.talents[1]!.blackboard.nums;
  const s1 = skill.skillId.endsWith('_1'), s2 = skill.skillId.endsWith('_2');
  const profile = necrosisProfile(boss), source = `skill:${skill.skillId}`;
  // 笞心击、怵然震爆的黑板均按实际法术伤害积累。机械臂的概率分支可分别打出物理、法术伤害。
  const buildupRatio = (hit: DamageComponent) => artsFraction(hit) * (bb['attack@ep_damage_ratio'] ?? bb.ep_damage_ratio ?? 0);
  const cost = Math.max(e.spCostMin, level.spCost * e.spCostScale);
  const rate = Math.max(0, level.increment + e.spRecovery);
  const burstSp = tier.talents.find(slot => slot.blackboard.nums.sp_recovery_per_sec)?.blackboard.nums.sp_recovery_per_sec ?? 0;
  const soulInterval = talent['nymph_t_1[ep_damage].interval'] ?? 1;
  const refund = e.skillEndProbability===1 ? e.skillEndSp : 0;
  const needAfter = Math.max(0,cost-refund);
  const zeroLoop = refund>0 && needAfter===0 && s2;
  // 回技足以立即续开零时长技能时，两次施放至少间隔一个攻击间隔（模型假设）。
  const recovery = zeroLoop ? generic.normal.stats.attackInterval : needAfter<=0 ? cost===0 && s2 ? phase(context,e).stats.attackInterval : 0 : rate>0 ? needAfter/rate : Infinity;
  // 迅捷：每次技能真实结束（S1 持续结束、S2 每次瞬发）按固定判定序列判定一次回技。
  const swift = e.skillEndSp > 0 && e.skillEndProbability > 0;
  const afterEnd = swiftRecovery(e, cost, rate, generic.normal.stats.attackInterval, false);
  const need = Math.max(0, cost - level.initSp - e.initSp);
  const first = need === 0 ? 0 : rate > 0 ? need / rate : Infinity;
  const effects = (burst: boolean) => ({ ...e, modifiers: [...e.modifiers,
    { group: 'nymph-module', kind: 'increase' as const, value: burst ? (tier.trait?.blackboard.nums.damage_scale ?? 1) - 1 : 0, source: 'module:nymph' }] });
  const make = (active: boolean, burst: boolean, stacks: number, elapsed: number, damageEvents = 0) => phase(context, effects(burst), {
    ownerActions: 1, active, elapsed, damageEvents, type: active && !s1 && !s2 && burst ? 'elemental' : 'arts',
    scale: active && s2 ? bb.atk_scale! : 1,
    modifiers: [
      { stat: 'atk', bucket: 'pct', value: stacks * stacksTalent.atk! + (active && !s2 ? bb.atk! : 0), source },
      { stat: 'attackSpeed', bucket: 'direct', value: (active && !s1 && !s2 ? bb.attack_speed! : 0)
        + (stacks >= (stacksTalent.stack_cnt_check ?? Infinity) ? stacksTalent.attack_speed ?? 0 : 0), source },
    ],
  });
  const normal = make(false, false, 0, 0), initial = make(true, false, 0, first);
  const nominal = s2 ? initial.stats.attackInterval : level.duration;
  const displayEnd = first + nominal, cycleEnd = displayEnd + recovery + (s2 ? 0 : nominal);
  const elementalParts = (attack: number, damageEvents: number, scale: number, interval: number, label: string, partSource: string) => {
    const ctx = { ...context, tier: { ...tier, attributes: { ...tier.attributes, atk: attack } } };
    const { components } = phase(ctx, { ...arcaneOnly(effects(true)), stats: [], skillStats: [], timedStats: [], attackScale: 1 },
      { type: 'elemental', scale, fixedInterval: interval, damageEvents });
    components[0]!.label = label;
    components[0]!.source = partSource;
    return components;
  };
  const run = (duration: number, hp: number, collect = false) => {
    const clock = new ShredClock(e);
    const state = { buildup: 0, remaining: 0 };
    let time = 0, dealt = 0, total = 0, kill = hp <= 0 ? 0 : Infinity, stacks = 0;
    let active = false, nextCast = first, skillEnd = Infinity, soulScale = 0, ends = 0;
    const casts: number[] = [];
    const splashes: number[] = [];
    let reserve = Math.max(0, Math.min(level.initSp + e.initSp, cost * level.maxChargeTime) - cost);
    let skillDamage = 0, cycleDamage = 0;
    let firstDamage: number | undefined, moduleCycle: { seconds: number; damage: number } | undefined;
    const parts = new Map<string, DamageComponent>();
    const add = (components: DamageComponent[], seconds: number, skillComponents = components) => {
      const amount = components.reduce((n, c) => n + (seconds > 0 ? c.dps * seconds : c.perHit * c.hitsPerAttack), 0);
      if (time <= duration) total += seconds > 0 ? amount * Math.min(seconds, duration - time) / seconds : amount;
      if (kill === Infinity && amount > 0 && dealt + amount >= hp) kill = time + seconds * (hp - dealt) / amount;
      dealt += amount;
      if (collect && time >= first && time < displayEnd) {
        skillDamage += skillComponents.reduce((n, c) => n + (seconds > 0 ? c.dps * seconds : c.perHit * c.hitsPerAttack), 0);
        for (const c of skillComponents) {
          const key = `${c.source}:${c.damageType}`;
          parts.set(key, { ...c, dps: (parts.get(key)?.dps ?? 0) + (seconds > 0 ? c.dps * seconds : c.perHit * c.hitsPerAttack) });
        }
      }
      if (collect && time >= displayEnd && time < cycleEnd) cycleDamage += amount;
    };
    const trigger = () => { stacks = Math.min(stacksTalent.max_stack_cnt!, stacks + 1); soulScale = talent['nymph_t_1[ep_damage].element_atk_scale'] ?? talent.element_atk_scale!; };
    const skillHit = () => {
      const p = make(true, state.remaining > 0, stacks, time, clock.count);
      // 持续伤害按独立的每秒时钟由阶段秒伤连续计入，单段技能伤害不再结算一跳。
      p.components = p.components.filter(c => !isDotSource(c.source));
      add(p.components, 0);
      clock.burst(p.components);
      if (state.remaining === 0) {
        const hit = p.components[0]!;
        state.buildup += hit.perHit * buildupRatio(hit) * profile.buildupMultiplier;
        if (advanceNecrosis(state, profile, 0, 0).triggered) trigger();
      }
      if (state.remaining > 0) soulScale = Math.max(soulScale, bb.element_atk_scale!);
    };
    const canDamage = normal.dps > 0 || initial.dps > 0;
    while (time <= duration || (kill === Infinity && Number.isFinite(hp) && canDamage)) {
      if (active && time >= skillEnd) { active = false; skillEnd = Infinity; nextCast = time + afterEnd(ends++, time); }
      while (time >= nextCast && Number.isFinite(nextCast)) {
        if (time <= duration) casts.push(time);
        if (collect && burstSp) {
          if (firstDamage === undefined) firstDamage = dealt;
          else if (!moduleCycle && time > first) moduleCycle = { seconds: time - first, damage: dealt - firstDamage };
        }
        if (s2) {
          skillHit(); splashes.push(time + .33);
          const gained = swiftRefundSucceeds(ends++, swift ? e.skillEndProbability : 0, time) ? e.skillEndSp : 0;
          reserve = Math.min(cost*Math.max(1,level.maxChargeTime),reserve+gained);
          // 回技足以立即续开时，两次施放至少间隔一个攻击间隔（模型假设）。
          const wait = cost===0 ? recovery : reserve>=cost ? (gained > 0 ? generic.normal.stats.attackInterval : 0) : rate>0 ? (cost-reserve)/rate : Infinity;
          reserve = Math.max(0,reserve-cost);
          nextCast = time + wait;
        }
        else { active = true; skillEnd = time + level.duration; nextCast = Infinity; }
      }
      while (splashes.length && time >= splashes[0]!) { skillHit(); splashes.shift(); }
      const splashAt = splashes[0] ?? Infinity;
      const burst = state.remaining > 0;
      const p = make(active, burst, stacks, time, clock.count);
      const dot: DamageComponent[] = [];
      if (burst) {
        dot.push(...elementalParts(p.stats.atk, clock.count, soulScale, soulInterval, '失魂持续伤害', 'talent:nymph:soul'));
        dot.push({ label: '凋亡爆发持续伤害', source: 'elemental:necrosis', damageType: 'elemental',
          perHit: profile.dps, hitsPerAttack: 1, hitsPerSec: 1, dps: profile.dps, countsTowardDps: true, derivation: profile.derivation });
        if (active && s1) dot.push(...elementalParts(p.stats.atk, clock.count, bb['attack@extra_ep_damage_scale']!, p.stats.attackInterval, '笞心击附加元素', `${source}:elemental`));
      }
      const expiry = Math.min(...e.timedStats.filter(x => x.until > time).map(x => x.until));
      const tick = clock.step([...p.components, ...dot]);
      const boost = burst && rate > 0 && Number.isFinite(nextCast) ? burstSp / rate : 0;
      const due = boost ? time + (nextCast - time) / (1 + boost) : nextCast;
      const stop = Math.min(time + tick.seconds, due, splashAt, skillEnd, expiry, duration > time ? duration : Infinity,
        collect && displayEnd > time ? displayEnd : Infinity, collect && cycleEnd > time ? cycleEnd : Infinity) - time;
      const rawRate = active && s1 ? p.components[0]!.dps * buildupRatio(p.components[0]!) : 0;
      const step = advanceNecrosis(state, profile, rawRate, Math.max(0, stop));
      if (!Number.isFinite(step.seconds)) {
        const seconds = Math.max(0, duration - time, Number.isFinite(hp) && p.dps > 0 ? (hp - dealt) / p.dps : 0);
        if (seconds > 0) add(p.components, seconds, s2 ? [] : p.components);
        break;
      }
      add([...p.components, ...dot], step.seconds, s2 ? dot : [...p.components, ...dot]);
      tick.advance(step.seconds);
      time += step.seconds;
      if (boost) nextCast = time >= due ? time : Math.max(time, nextCast - step.seconds * boost);
      if (step.triggered) trigger();
      if (step.seconds === 0 && !step.triggered) break;
    }
    return { total, kill, skillDamage, cycleDamage, moduleCycle, parts, casts };
  };
  const preview = Number.isFinite(cycleEnd) ? run(cycleEnd, Infinity, true) : null;
  const actualCycle = preview?.moduleCycle;
  const skillPhase: PhaseResult = preview ? { ...initial, dps: preview.skillDamage / nominal,
    components: [...preview.parts.values()].map(c => ({ ...c, dps: c.dps / nominal, hitsPerSec: c.perHit > 0 ? c.dps / nominal / c.perHit : 0 })) }
    : { ...initial, dps: initial.dps * (s2 ? 2 : 1), components: initial.components.map(c => ({ ...c, hitsPerAttack: c.hitsPerAttack * (s2 ? 2 : 1), hitsPerSec: c.hitsPerSec * (s2 ? 2 : 1), dps: c.dps * (s2 ? 2 : 1) })) };
  base.notes.push('近似：凋亡与失魂按连续伤害率积分；失魂伤害随当前攻击力刷新，忽略离散tick及攻击刷新延迟。',
    '近似：卫戍99恐惧增加【迅捷】层数仅沿用用户输入，不自动累加；恐惧免疫Boss不会触发该特质。');
  if (s2) base.notes.push('近似：S2技能DPS为首个普攻间隔窗口内技能伤害的等效值；两段相隔0.33秒，忽略施法动作阻塞，普攻连续积分。初始库存可连续施放并保留技力余数，后续充能可用即开，不预存。');
  if (s2 && cost === 0) base.notes.push('近似：零技力S2按一个普攻间隔限制连续施放，避免零时间无限施法；未模拟真实施法动作。');
  if (!boss.levelType) base.notes.push('近似：Boss身份缺失，凋亡阈值按领袖2000。');
  base.caveats.push('单干员普攻及S3不积累凋亡；无队友触发时，S3元素转换、失魂和爆发叠攻不触发。',
    '静止Boss不模拟恐惧移动；额外目标不重复命中，S2溅射明确包含主目标。凋亡虚弱不影响不受击场景DPS。');
  return { ...base, normal, skill: skillPhase, lifecycle: s2 ? 'instant' : 'timed', duration: s2 ? 0 : level.duration, burst: s2, passive: false,
    elemental: { perSec: s1 ? initial.components[0]!.dps * buildupRatio(initial.components[0]!) * profile.buildupMultiplier
      : s2 ? 2 * initial.components[0]!.perHit * buildupRatio(initial.components[0]!) * profile.buildupMultiplier / (actualCycle?.seconds ?? recovery) : 0,
      note: 'S1首次技能未爆发时的损伤速率；S2两段损伤按回转平均；普攻与S3为0，15秒爆发期间不积累。' },
    customTimeline: (duration, hp) => {
      const swiftNotes:string[]=[];
      if (swift && (s1 || s2)) swiftNotes.push(swiftNote);
      if (swift && s2) swiftNotes.push(swiftLockNote);
      if (!s1 && !s2 && e.skillEndProbability && e.skillEndSp) {
        const expiry = Math.max(0,...e.timedStats.map(x=>x.until));
        const stages=(seconds:number,start:number,active:boolean)=>{
          if(start===Infinity) return [{duration:seconds,dps:make(active,false,0,Infinity).dps}];
          const end=start+seconds;
          let from=start;
          return [...e.timedStats.map(x=>x.until).filter(t=>t>start && t<end).sort((a,b)=>a-b),end].map(to=>{
            const part={duration:to-from,dps:make(active,false,0,from).dps}; from=to; return part;
          });
        };
        return swiftRenewal({prefix:[...stages(first,0,false),...stages(level.duration,first,true)], stock:0,cost,
          maxCharges:level.maxChargeTime,reward:e.skillEndSp,probability:e.skillEndProbability,
          wait:need=>need<=0 ? 0 : rate>0 ? need/rate : Infinity, stableAfter:expiry,
          segments:(r,t)=>[...stages(r,t,false),...stages(level.duration,t+r,true)],skillDuration:level.duration},duration,hp);
      }
      const result = run(duration, hp);
      return { totalDamage: result.total, killTimeSec: result.kill,
        cycle: preview ? { spRecoverSec: actualCycle ? actualCycle.seconds - (s2 ? 0 : level.duration) : recovery, skillDurationSec: s2 ? 0 : level.duration,
          avgDps: actualCycle ? actualCycle.damage / actualCycle.seconds : preview.cycleDamage / (cycleEnd - displayEnd) } : null,
        castsUntil: (t: number) => run(t, Infinity).casts,
        notes: [...swiftNotes, actualCycle ? '近似：PRI-Y 只在凋亡爆发且未锁技时额外回技；循环取首次至再次施放。' : '近似：循环DPS取首轮展示窗口结束后的一个循环；后续凋亡相位与叠攻会改变伤害。'], caveats: [] };
    },
  };
};
