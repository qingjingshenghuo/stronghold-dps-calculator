import { swiftCycles } from './swift.ts';
import { firstCrossing, stockAfterCast, swiftNote, swiftRenewal, swiftRefundSucceeds } from '../../swift.ts';
import { ShredClock } from '../../effects/shred-clock.ts';
import type { StatModifier } from '../../stats.ts';
import type { SkillOverride } from './index.ts';
import { battleEffects } from '../../effects/common.ts';
import { castMark, castTimes, integrate, integrateWithCasts, type Segment } from '../../timeline.ts';
import { arcaneOnly, overrideBase, phase } from './shared.ts';
import { damage } from '../../damage.ts';
import { necrosisProfile } from '../../effects/elemental.ts';
import { moduleElement, type ElementStage } from './module-element.ts';

// https://prts.wiki/w/棘刺：中毒仅刷新；领主近战无80%惩罚；S3二开双加成永久；S2受击才反击。
export const thornsOverride: SkillOverride = (context, generic) => {
  const { tier, skill, level } = context;
  const model = overrideBase(generic);
  const e = generic.battle ?? battleEffects();
  const bb = level.blackboard.nums;
  const source = `skill:${skill.skillId}`;
  const talent = tier.talents[0]!.blackboard.nums;
  const poisonAt = (damageEvents: number, active = false, modifiers: StatModifier[] = [], effects = e) => {
    const result = phase(context, arcaneOnly(effects), { type: 'arts', scale: 0, damageEvents, active, modifiers,
      attackAdd: talent['damage[normal]']!, fixedInterval: 1 });
    result.components[0]!.label = '神经腐蚀（不叠加）';
    result.components[0]!.source = 'talent:thorns:1';
    return result;
  };
  const poison = poisonAt(0);
  const make = (active: boolean, second = false, damageEvents = 0, effects = e) => {
    const modifiers = [{ stat: 'atk' as const, bucket: 'pct' as const, value: active ? bb[second ? 'thorns_s_3[b].atk' : 'atk'] ?? 0 : 0, source },
      { stat: 'attackSpeed' as const, bucket: 'direct' as const, value: active ? bb[second ? 'thorns_s_3[b].attack_speed' : 'attack_speed'] ?? 0 : 0, source }];
    const p = phase(context, effects, { ownerActions: 1, active, damageEvents, type: 'physical', modifiers });
    const moduleScale = tier.trait?.blackboard.nums.atk_scale_m ?? 0;
    if (moduleScale) {
      const module = phase(context, arcaneOnly(effects), { active, damageEvents, type: 'arts', scale: moduleScale, modifiers });
      module.components[0]!.source = `module:${tier.uniEquipId}`;
      module.components[0]!.label = '模组逐击法术伤害';
      p.components.push(...module.components);
    }
    const coverage = Math.min(1, talent.duration! / p.stats.attackInterval);
    const dot = damageEvents || active ? poisonAt(damageEvents, active, modifiers, effects) : poison;
    p.components.push(...dot.components.map(hit => ({ ...hit, dps: hit.dps * coverage, hitsPerSec: hit.hitsPerSec * coverage })));
    p.dps = p.components.reduce((sum, c) => sum + c.dps, 0);
    return p;
  };
  model.normal = make(false);
  const s2 = skill.skillId.endsWith('_2'), s3 = skill.skillId.endsWith('_3');
  model.skill = s2 ? phase(context, e, { active: true, type: 'none' }) : make(true);
  model.lifecycle = s3 ? 'permanent' : 'timed';
  model.duration = s3 ? Infinity : level.duration;
  model.burst = false;
  model.passive = false;
  model.notes.push(`近似：Boss数据未提供图鉴攻击方式，中毒按普通目标${talent['damage[normal]']}点/秒，不擅自启用远程目标双倍；毒覆盖按持续时间/攻击间隔折算，忽略首击延迟。`);
  if (e.timedStats.length) model.notes.push('近似：限时外部属性按部署值计算，未在到期时重建伤害阶段');
  model.caveats.push('自行阻挡Boss，普攻不受远程80%惩罚；本模式模组最高1级，毒不叠层；休整盟约已通过输入层数计入。');
  const cost = Math.max(e.spCostMin, level.spCost * e.spCostScale);
  const rate = s3 ? 1 / model.normal.stats.attackInterval : Math.max(0, level.increment + e.spRecovery);
  const wait = (sp: number) => sp <= 0 ? 0 : rate > 0 ? (s3 ? Math.ceil(sp) : sp) / rate : Infinity;
  const first = wait(cost - level.initSp - e.initSp), recovery = wait(cost);
  const active: Segment[] = s2 ? [{ duration: Math.min(level.duration, talent.duration!), dps: poison.dps, cast: true },
    { duration: Math.max(0, level.duration - talent.duration!), dps: 0 }] : [{ duration: level.duration, dps: model.skill.dps, cast: true }];
  const prefix: Segment[] = [{ duration: first, dps: model.normal.dps }, ...active];
  let repeat: Segment[] = [];
  const permanent = s3 ? make(true, true) : null;
  if (permanent) {
    prefix.push({ duration: recovery, dps: model.normal.dps }, { duration: Infinity, dps: permanent.dps, cast: true });
    model.notes.push('近似：攻击回复按每次普攻1SP连续折算，技能期间不回SP；技能期DPS为首次开启，常驻DPS为二次开启。');
  } else repeat = [{ duration: recovery, dps: model.normal.dps }, ...active];
  if (s2) model.notes.push('近似：不受击场景下S2不反击；开启时按刚刷新中毒保留3秒残毒（初始即开时不计残毒）。');
  if (s2 && first === 0) prefix.splice(1, active.length, { duration: level.duration, dps: 0, cast: true });
  const ratio = tier.trait?.blackboard.nums.ep_damage_ratio;
  if (ratio) {
    // PRTS https://prts.wiki/w/元素 ：对敌神经爆发即扣6000元素伤害，锁条10秒；一级LOR-D不改变毒的类型。
    const profile = { ...necrosisProfile(context.boss), duration: 10 };
    const burst = damage({ attack: 6000, type: 'elemental', epDamageResistance: context.boss.attributes?.epDamageResistance, target: context.boss });
    const stage = (duration: number, active: boolean, second = false): ElementStage => ({ duration, active,
      phase: (events, _time, _burst, effects) => make(active, second, events, effects) });
    const silent = model.skill!;
    const cast = (waited: number): ElementStage[] => {
      if (!s2) return [{ ...stage(level.duration, true), cast: true }];
      const linger = waited > 0 ? Math.min(level.duration, talent.duration!) : 0;
      // 残毒保留每秒一跳的频率；技能面板仍显示停攻时的本体间隔。
      return [{ duration: linger, active: true, cast: true, phase: (events, _time, _burst, effects) =>
        ({ ...poisonAt(events, false, [], effects), stats: silent.stats }) },
        { duration: level.duration - linger, active: true, phase: () => silent }];
    };
    // 迅捷：每次技能真实结束时按固定判定序列判定一次；成功时这一轮回复只需补足 消耗 − 回技。
    const probability = e.skillEndSp > 0 ? e.skillEndProbability : 0;
    const recharge = wait(cost), quick = wait(cost - e.skillEndSp);
    const opening = [stage(first, false), ...cast(first)];
    const repeat = [stage(recharge, false), ...cast(recharge)];
    const quickRepeat = [stage(quick, false), ...cast(quick)];
    // S3 仅首次技能会结束：第 0 次判定决定进入永续前的回复时间。
    if (permanent) opening.push((swiftRefundSucceeds(0, probability, first + level.duration) ? quickRepeat : repeat)[0]!, { ...stage(Infinity, true, true), cast: true });
    return moduleElement(model, profile, panel => ratio * panel.components.reduce((sum, hit) => sum + (hit.damageType === 'physical' || hit.damageType === 'arts' ? hit.dps : 0), 0),
      opening, permanent ? [] : repeat, probability >= 1 ? quick : recharge, { label: '神经损伤爆发', source: 'elemental:neural', damageType: 'elemental', countsTowardDps: true,
        perHit: burst.perHit, hitsPerAttack: 1, hitsPerSec: 0, dps: 0, derivation: burst.derivation },
      !permanent && probability > 0 ? { probability, quick: quickRepeat } : undefined, context.effectsAt);
  }
  model.customTimeline = (duration, hp) => ({ ...integrateWithCasts(prefix, repeat, duration, hp),
    cycle: permanent ? { spRecoverSec: recovery, skillDurationSec: Infinity, avgDps: permanent.dps }
      : { spRecoverSec: recovery, skillDurationSec: level.duration,
        avgDps: Number.isFinite(recovery) ? (recovery * model.normal.dps + active.reduce((sum, s) => sum + s.duration * s.dps, 0)) / (recovery + level.duration) : model.normal.dps },
    notes: [], caveats: [] });
  if (permanent && e.skillEndProbability > 0 && e.skillEndSp > 0) {
    // 仅首次技能会结束：第0次判定（固定判定序列）成功则回技后更早进入永续。
    const wait0 = swiftRefundSucceeds(0, e.skillEndProbability, first + level.duration) ? wait(cost - e.skillEndSp) : recovery;
    const path = [...prefix.slice(0, -2), { duration: wait0, dps: model.normal.dps }, { duration: Infinity, dps: permanent.dps, cast: true }];
    model.customTimeline = (duration, hp) => ({ ...integrateWithCasts(path, [], duration, hp),
      cycle: { spRecoverSec: wait0, skillDurationSec: Infinity, avgDps: permanent.dps },
      notes: [swiftNote], caveats: [] });
  }
  if (!permanent) swiftCycles(model, level, cost, level.initSp + e.initSp, prefix, wait,
    seconds => [{ duration: seconds, dps: model.normal.dps }, ...(s2 && seconds === 0 ? [{ duration: level.duration, dps: 0 }] : active)]);
  if (e.resShred) {
    const cap = Math.ceil(e.resShred.max / e.resShred.perHit);
    const ramp = (count: number, seconds: number, mode: 'normal' | 'skill' | 'permanent' | 'poison') => {
      const parts: Segment[] = [];
      const build = (events: number) => mode === 'poison' ? poisonAt(events) : make(mode !== 'normal', mode === 'permanent', events);
      const clock = new ShredClock(e);
      clock.count = count;
      clock.append(parts, seconds, build);
      return {count:clock.count, parts};
    };
    const cast = (count: number, seconds: number) => {
      const start = ramp(count, seconds, 'normal');
      const span = s2 ? Math.min(level.duration, seconds > 0 ? talent.duration! : 0) : level.duration;
      const skill = ramp(start.count, span, s2 ? 'poison' : 'skill');
      return {count: skill.count, parts: [...start.parts, castMark(), ...skill.parts, {duration:level.duration - span, dps:0}]};
    };
    const opening = cast(0, first);
    if (s3) {
      const probability = e.skillEndSp > 0 ? e.skillEndProbability : 0, quick = wait(cost - e.skillEndSp);
      const path = (seconds: number) => {
        const normal = ramp(opening.count, seconds, 'normal');
        return [...opening.parts, ...normal.parts, castMark(), ...ramp(normal.count, Infinity, 'permanent').parts];
      };
      // 仅首次技能结束时判定一次（固定判定序列第0次）。
      const seconds = swiftRefundSucceeds(0, probability, first + level.duration) ? quick : recovery;
      const chosen = path(seconds), dps = make(true, true, cap).dps;
      model.customTimeline = (window, hp) => {
        const at = (time: number) => integrate(chosen, [], time, Infinity).totalDamage;
        return {totalDamage:at(window), killTimeSec:firstCrossing(at, hp, hp / dps), cycle:{spRecoverSec:seconds, skillDurationSec:Infinity, avgDps:dps}, notes:[], caveats:[],
          castsUntil: (t: number) => castTimes(chosen, [], t) ?? []};
      };
    } else model.customTimeline = (duration, hp) => swiftRenewal({prefix:opening.parts, stock:stockAfterCast(level.initSp + e.initSp, cost, level.maxChargeTime),
      cost, maxCharges:level.maxChargeTime, probability:e.skillEndProbability, reward:e.skillEndSp, wait,
      segments: seconds => cast(cap, seconds).parts, skillDuration:level.duration,
      counter:{initial:opening.count, afterCharge:(count, seconds, stock) => [{...cast(count, seconds), stock, weight:1}]},
    }, duration, hp);
  }
  return model;
};
