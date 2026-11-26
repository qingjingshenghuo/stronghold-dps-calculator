import { judgmentSource } from '../../effects/judgment.ts';
import { firstCrossing, swiftRenewal, swiftRefundSucceeds } from '../../swift.ts';
import type { SkillOverride } from './index.ts';
import type { PhaseResult } from '../../types.ts';
import { battleEffects } from '../../effects/common.ts';
import { artsContribution, necrosisProfile } from '../../effects/elemental.ts';
import { integrate, type Segment } from '../../timeline.ts';
import { arcaneOnly, overrideBase, phase, withFirstSkill } from './shared.ts';
import { moduleElement, type ElementStage } from './module-element.ts';

// https://prts.wiki/w/逻各斯 ：Y模组重复执行天赋两次，且天赋伤害可触发模组回技力；
// 第二天赋先减抗、再在倍率之后/法抗之前逐击加算；S2固定0.5秒、不受攻速，5秒线性爬升。
export const logosOverride: SkillOverride = (context, generic) => {
  const { tier, level, skill, boss } = context;
  const initialEffects = generic.battle ?? battleEffects();
  let e = initialEffects;
  let effectTime = 0;
  let damageEvents = 0;
  const model = overrideBase(generic);
  if (e.bondStacks || e.resShred || e.timedStats.length) {
    model.notes = model.notes.filter(n => !n.includes('精建时间过程尚未逐事件'));
    if (e.stacks.length) model.notes.push('近似：装备攻击/技能/秒数属性叠层尚未重建');
    model.notes.push('近似：伤害触发叠层按完整攻击间隔末端更新，天赋伤害段数取概率期望；伤害与技力在事件之间连续积分');
    if (e.bondStacks && !context.effectsAt) model.notes.push('忽略了临时盟约层数：缺少外部效果重算接口');
  }
  const talent = tier.talents[0]!.blackboard.nums;
  const debuff = tier.talents[1]!.blackboard.nums;
  const bb = level.blackboard.nums;
  const proc = talent.prob! * (talent.emit_count ?? 1);
  const ratio = tier.talents.find(slot => slot.blackboard.nums.ep_damage_ratio)?.blackboard.nums.ep_damage_ratio;
  const necrosis = ratio ? necrosisProfile(boss) : undefined;
  const options = { resReductionFixed: -debuff.magic_resistance!, artsHitAdd: debuff.atk_addition! };
  const make = (active: boolean, scale = 1, fixedInterval?: number, burst = false, effects = e): PhaseResult => {
    const modifiers = active && bb.atk !== undefined ? [{ stat: 'atk' as const, bucket: 'pct' as const, value: bb.atk, source: `skill:${skill.skillId}` }] : [];
    const p = phase(context, effects, { ...options, ownerActions: 1, active, modifiers, scale, elapsed: effectTime, damageEvents });
    // 盟约描述及 PRTS 逻各斯：天赋是独立伤害，逐击行为尚无模式内实测；不允许附加段再触发。
    const extra = phase(context, arcaneOnly(effects), { ...options, active, modifiers, scale: talent.atk_scale, elapsed: effectTime, damageEvents });
    // 单Boss在随机目标池内；Y模组两次独立执行可以选中同一个目标。
    p.components.push(...extra.components.map((c, index) => ({ ...c, label: index ? '语汇演化触发奥术' : '语汇演化（概率期望）', source: index ? c.source : 'talent:logos:1', hitsPerAttack: c.hitsPerAttack * proc, hitsPerSec: c.hitsPerSec * proc, dps: c.dps * proc })));
    if (burst) {
      const element = phase(context, arcaneOnly(effects), { ...options, type: 'elemental', active, modifiers, scale: talent.element_atk_scale, hits: proc, elapsed: effectTime, damageEvents });
      element.components[0]!.label = '语汇演化·爆发期元素伤害';
      element.components[0]!.source = 'talent:logos:elemental';
      p.components.push(...element.components);
    }
    if (fixedInterval !== undefined) {
      const ratio = p.stats.attackInterval / fixedInterval;
      p.stats = { ...p.stats, attackInterval: fixedInterval, derivation: { ...p.stats.derivation, attackInterval: [...p.stats.derivation.attackInterval, { label: '提喻固定间隔（不受攻速）', value: fixedInterval, op: 'set', source: 'https://prts.wiki/w/逻各斯' }] } };
      p.components = p.components.map(c => ({ ...c, hitsPerSec: c.hitsPerSec * ratio, dps: c.dps * ratio }));
    }
    if (burst && necrosis) p.components.push({ label: '凋亡爆发持续伤害', source: 'elemental:necrosis', damageType: 'elemental', countsTowardDps: true,
      perHit: necrosis.dps, hitsPerAttack: 1, hitsPerSec: 1, dps: necrosis.dps, derivation: necrosis.derivation });
    p.dps = p.components.reduce((sum, c) => sum + c.dps, 0);
    return p;
  };
  if (e.extraHits.some(hit => hit.source === 'bond:arcaneShip')) model.notes.push('近似：按盟约描述与PRTS逻各斯天赋备注，语汇演化各段可触发奥术；逐击行为尚无模式内实测');
  if (e.extraHits.some(hit => hit.source !== 'bond:arcaneShip')) model.notes.push('近似：装备附加伤害仅由原攻击触发；语汇演化能否触发该装备的额外伤害未确认');
  model.normal = make(false);
  model.skill = make(true);
  model.notes.push(ratio ? '近似：CCR-D 语汇演化按单次概率期望；法伤积累凋亡，仅在爆发期间附加天赋元素伤害。' : '近似：语汇演化按概率期望；单Boss作为随机目标，Y模组两次执行可重复命中同一目标（PRTS逻各斯天赋备注）');
  const elite = boss.levelType === 'ELITE' || boss.levelType === 'BOSS';
  const traitSp = tier.trait?.blackboard.nums.sp ?? 0;
  if (traitSp && !boss.levelType) model.notes.push('忽略了精英/领袖命中回技力：敌人身份数据缺失');
  const rate = level.increment + e.spRecovery + (elite ? traitSp * (1 + proc) / model.normal.stats.attackInterval : 0);
  const cost = Math.max(e.spCostMin, level.spCost * e.spCostScale);
  const wait = (sp: number) => sp <= 0 ? 0 : rate > 0 ? sp / rate : Infinity;
  const first = wait(Math.max(0, cost - level.initSp - e.initSp));
  const recovery = wait(cost);
  let active: Segment[];
  if (skill.skillId.endsWith('_1')) {
    model.lifecycle = 'permanent';
    model.duration = Infinity;
    active = [{ duration: Infinity, dps: model.skill.dps, executeBelow: model.skill.stats.atk * bb['attack@kill_atk_scale']! }];
    model.notes.push('近似：S1斩杀按输入Boss血量计算；PRTS指出卫戍最终攻势Boss另有生命系统，实际斩杀触发可能不同');
    model.caveats.push('单Boss斩杀没有另一个目标，因此不计斩杀转移法伤');
  } else if (skill.skillId.endsWith('_2')) {
    model.lifecycle = 'timed';
    model.duration = level.duration;
    const base = make(true, bb['attack@atk_scale_base'], bb['attack@cooldown']);
    const top = make(true, bb['attack@atk_scale_base']! + bb['attack@atk_scale_delta']! * bb['attack@max_stack_cnt']!, bb['attack@cooldown']);
    const ramp = bb['attack@cooldown']! * bb['attack@max_stack_cnt']!;
    active = [{ duration: ramp, dps: base.dps, slope: (top.dps - base.dps) / ramp }, { duration: level.duration - ramp, dps: top.dps }];
    model.skill = { ...top, components: top.components.map((c, i) => ({ ...c, perHit: (base.components[i]!.perHit + c.perHit) / 2 * ramp / level.duration + c.perHit * (level.duration - ramp) / level.duration, dps: (base.components[i]!.dps + c.dps) / 2 * ramp / level.duration + c.dps * (level.duration - ramp) / level.duration })) };
    model.skill.dps = model.skill.components.reduce((n, c) => n + c.dps, 0);
    model.caveats.push('S2技能期DPS显示完整技能平均值；锁定同一静止Boss不中断，前5秒线性爬升，之后保持上限');
  } else {
    model.lifecycle = 'timed';
    model.duration = level.duration;
    active = [{ duration: level.duration, dps: model.skill.dps }];
    model.caveats.push('S3多目标只计单Boss一份攻击；子弹减速与清除不影响满血不受击场景DPS');
  }
  model.passive = false;
  model.burst = false;
  if (ratio && necrosis) {
    const stage = (duration: number, active: boolean, scale = 1, interval?: number): ElementStage => ({ duration, active,
      executeBelow: active && model.duration === Infinity ? model.skill!.stats.atk * bb['attack@kill_atk_scale']! : undefined,
      phase: (events, time, burst, effects) => { damageEvents = events; effectTime = time; return make(active, scale, interval, burst, effects); } });
    const interval = bb['attack@cooldown'], stacks = bb['attack@max_stack_cnt'];
    const casts = interval && stacks ? [...Array.from({ length: stacks }, (_, index) =>
      stage(interval, true, bb['attack@atk_scale_base']! + (index + .5) * bb['attack@atk_scale_delta']!, interval)),
      stage(model.duration - stacks * interval, true, bb['attack@atk_scale_base']! + stacks * bb['attack@atk_scale_delta']!, interval)] : [stage(model.duration, true)];
    // 迅捷：每次技能真实结束时按固定判定序列判定一次；成功时这一轮回复只需补足 消耗 − 回技。
    const probability = e.skillEndSp > 0 ? e.skillEndProbability : 0;
    const recharge = wait(cost), quick = wait(cost - e.skillEndSp);
    if (interval) model.notes.push('近似：提喻爬升按每个固定攻击间隔的中点积分凋亡积累。');
    const finite = model.duration !== Infinity;
    casts[0] = { ...casts[0]!, cast: true };
    return moduleElement(model, necrosis, panel => ratio * artsContribution(panel.components),
      [stage(first, false), ...casts], finite ? [stage(recharge, false), ...casts] : [], finite ? probability >= 1 ? quick : recharge : null, undefined,
      finite && probability > 0 ? { probability, quick: [stage(quick, false), ...casts] } : undefined, context.effectsAt);
  }
  model.customTimeline = (duration, hp) => {
    e = initialEffects; effectTime = 0; damageEvents = 0;
    if (e.resShred || e.timedStats.length || e.bondStacks && context.effectsAt) {
      const prefix: Segment[] = [];
      let sp = Math.min(cost, Math.max(0, level.initSp + e.initSp));
      let age: number | null = null;
      let progress = 0;
      let ends = 0;
      const segments = (): Segment[] => {
        if (skill.skillId.endsWith('_2')) {
          const ramp = bb['attack@cooldown']! * bb['attack@max_stack_cnt']!;
          const base = make(true, bb['attack@atk_scale_base'], bb['attack@cooldown']);
          const top = make(true, bb['attack@atk_scale_base']! + bb['attack@atk_scale_delta']! * bb['attack@max_stack_cnt']!, bb['attack@cooldown']);
          return [{ duration: ramp, dps: base.dps, slope: (top.dps - base.dps) / ramp }, { duration: level.duration - ramp, dps: top.dps }];
        }
        const p = make(true);
        return [{ duration: model.duration, dps: p.dps, executeBelow: model.duration === Infinity ? p.stats.atk * bb['attack@kill_atk_scale']! : undefined }];
      };
      const remaining = (parts: Segment[], elapsed: number): Segment[] => {
        const result: Segment[] = [];
        for (const part of parts) {
          const skip = Math.min(elapsed, part.duration);
          elapsed -= skip;
          if (skip < part.duration) result.push({ ...part, duration: part.duration - skip, dps: part.dps + (part.slope ?? 0) * skip });
        }
        return result;
      };
      const run = (duration:number,hp:number):ReturnType<typeof swiftRenewal> => { while (true) {
        e = context.effectsAt?.(damageEvents) ?? initialEffects;
        if (age !== null && age >= model.duration - 1e-9) {
          age = null;
          // 迅捷：每次技能结束按固定判定序列判定一次。
          if (e.skillEndProbability && e.skillEndSp && swiftRefundSucceeds(ends, e.skillEndProbability, effectTime))
            sp = Math.min(Math.max(e.spCostMin, level.spCost * e.spCostScale) * Math.max(1, level.maxChargeTime), sp + e.skillEndSp);
          ends++;
        }
        const normal = make(false);
        const currentCost = Math.max(e.spCostMin, level.spCost * e.spCostScale);
        const currentRate = level.increment + e.spRecovery + (elite ? traitSp * (1 + proc) / normal.stats.attackInterval : 0);
        const waitFor = (need: number) => need <= 0 ? 0 : currentRate > 0 ? need / currentRate : Infinity;
        if (age === null && sp >= currentCost - 1e-9) { sp -= currentCost; age = 0; }
        const parts = segments();
        const left = age === null ? [] : remaining(parts, age);
        const pendingHits = (e.bondStacks && context.effectsAt && damageEvents * e.bondStacks.perDamage < e.bondStacks.max)
          || (e.resShred && damageEvents * e.resShred.perHit < e.resShred.max);
        const expiry = Math.min(...e.timedStats.filter(t => t.until > effectTime + 1e-9).map(t => t.until));
        if (!pendingHits && expiry === Infinity) {
          if (age !== null) prefix.push(...left);
          if (model.duration!==Infinity && e.skillEndProbability && e.skillEndSp) {
            if (age===null) prefix.push({duration:waitFor(currentCost-sp),dps:normal.dps},...parts);
            const result = swiftRenewal({prefix,stock:Math.max(0,age===null ? sp-currentCost : sp),cost:currentCost,
              maxCharges:level.maxChargeTime,reward:e.skillEndSp,probability:e.skillEndProbability,wait:waitFor,
              segments:r=>[{duration:r,dps:normal.dps},...parts],skillDuration:model.duration,drawOffset:ends},duration,hp);
            return result;
          }
          const recovery = waitFor(currentCost);
          const repeat = model.duration === Infinity ? [] : [{ duration: recovery, dps: normal.dps }, ...parts];
          if (age === null || model.duration !== Infinity) prefix.push({ duration: waitFor(currentCost - sp), dps: normal.dps }, ...parts);
          const amount = parts.reduce((n, s) => n + s.duration * s.dps + (s.slope ? s.slope * s.duration ** 2 / 2 : 0), 0);
          return { ...integrate(prefix, repeat, duration, hp), cycle: model.duration === Infinity ? null : { spRecoverSec: recovery, skillDurationSec: model.duration, avgDps: Number.isFinite(recovery) ? (normal.dps * recovery + amount) / (recovery + model.duration) : normal.dps }, notes: [], caveats: [] };
        }
        const p = age === null ? normal : skill.skillId.endsWith('_2') ? make(true, bb['attack@atk_scale_base'], bb['attack@cooldown']) : make(true);
        const part = age === null ? { duration: waitFor(currentCost - sp), dps: normal.dps } : left[0]!;
        const toAttack = pendingHits ? (1 - progress) * p.stats.attackInterval : Infinity;
        const delta = Math.min(part.duration, toAttack, expiry - effectTime);
        prefix.push({ ...part, duration: delta });
        if (age === null) sp += delta * currentRate; else age += delta;
        progress += delta / p.stats.attackInterval;
        effectTime += delta;
        if (toAttack <= delta + 1e-9) {
          damageEvents += p.components.filter(c => c.countsTowardDps && c.source !== judgmentSource).reduce((n, c) => n + c.hitsPerAttack, 0);
          progress = 0;
        } else progress %= 1;
      } };
      return run(duration,hp);
    }
    if (model.duration!==Infinity && e.skillEndProbability && e.skillEndSp)
      return swiftRenewal({prefix:[{duration:first,dps:model.normal.dps},...active],stock:0,cost,maxCharges:level.maxChargeTime,
        reward:e.skillEndSp,probability:e.skillEndProbability,wait,segments:r=>[{duration:r,dps:model.normal.dps},...active],
        skillDuration:model.duration},duration,hp);
    const repeat = model.duration === Infinity ? [] : [{ duration: recovery, dps: model.normal.dps }, ...active];
    return { ...integrate([{ duration: first, dps: model.normal.dps }, ...active], repeat, duration, hp),
      cycle: model.duration === Infinity ? null : { spRecoverSec: recovery, skillDurationSec: model.duration, avgDps: Number.isFinite(recovery) ? (recovery * model.normal.dps + model.duration * model.skill!.dps) / (recovery + model.duration) : model.normal.dps }, notes: [], caveats: [] };
  };
  return withFirstSkill(model, result => {
    const start = result.firstCast ?? first;
    return { start, end: start + model.duration };
  });
};
