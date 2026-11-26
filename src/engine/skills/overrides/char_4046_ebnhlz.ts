import { operatorAttack, instant } from './operator-attack.ts';
import { artsContribution, necrosisProfile } from '../../effects/elemental.ts';

// 来源：干员当前阶级的特性、天赋及所选技能黑板；卫戍属性由公共入口注入。
export const ebnhlzOverride = operatorAttack('arts', ({ ctx, n, b, talent, hit, add, notes }) => {
  const talentScale = talent(1).atk_scale ?? 0;
  const normal = add(hit(false), false, '孤立目标附伤', { scale:talentScale });
  notes.push('始终只有一个可攻击的 Boss，不预存能量；孤立目标附伤单独受法抗。');
  const interval = ctx.tier.attributes.baseAttackTime * (n === 1 ? b.base_attack_time! : 1);
  const opts = { atk:b.atk, speed:b.attack_speed, interval };
  const skill = n === 2 ? hit(true,{ scale:b.atk_scale, ownerActions:0 })
    : add(hit(true, { ...opts, scale:b['attack@atk_scale'] }), true, '孤立目标附伤', { ...opts, scale:talentScale });
  if (n === 2) notes.push('默认目标地块可部署，生成一枚残影并立即引爆；其爆炸归召唤物，不触发本体模组损伤。');
  const rotation = n === 2 ? instant(normal,skill) : { normal,skill };
  const ratio = ctx.tier.talents.find(t => t.blackboard.nums.ep_damage_ratio)?.blackboard.nums.ep_damage_ratio;
  if (!ratio) return rotation;
  const profile = necrosisProfile(ctx.boss);
  notes.push('凋亡模组以本体已结算的法术伤害积累损伤，沿各次施放保留元素条，爆发期间每秒结算元素伤害（PRTS 元素）。');
  return { ...rotation, sequence:{ element:{ ...profile, burstDps:profile.dps,
    rate:p => ratio * artsContribution(p.components.filter(c => c.source === 'attack' || c.source.startsWith('skill:'))) } } };
});
