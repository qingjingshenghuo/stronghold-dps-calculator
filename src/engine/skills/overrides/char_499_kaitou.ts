import { operatorAttack } from './operator-attack.ts';
import { necrosisProfile } from '../../effects/elemental.ts';
import { artsFraction } from '../../damage.ts';

// 来源：干员当前阶级的特性、天赋及所选技能黑板；卫戍属性由公共入口注入。
export const kaitouOverride = operatorAttack('arts', ({ ctx, n, b, trait, talent, hit, add, notes }) => {
  const normal = hit(false), skill = hit(true,{ atk:b.atk, speed:b.attack_speed });
  if (n === 2) {
    notes.push('未指定外源凋亡，热处理变色不自行积累损伤，单 Boss 仅命中一次。');
    return { normal, skill };
  }
  const profile = necrosisProfile(ctx.boss), moduleScale = trait.damage_scale ?? 1, atk = talent(0).atk ?? 0;
  const normalBurst = hit(false,{ atk, scale:moduleScale });
  const skillBurst = add(hit(true,{ atk:atk + b.atk!, scale:moduleScale }),true,'爆发期元素附伤',
    { type:'elemental', atk:atk + b.atk!, scale:moduleScale * b['attack@extra_ep_damage_scale']! });
  notes.push('只由本人技能积累凋亡；按伤害速率累积，达到领袖阈值后开启 15 秒爆发，期间不重新积累（PRTS 元素）。');
  return { normal, skill, sequence:{ element:{ ...profile, burstDps:profile.dps,
    rate:(p,s) => s.active ? p.components[0]!.dps * artsFraction(p.components[0]!) * b['attack@ep_damage_ratio']! : 0 },
    select:s => s.active ? s.elementActive ? skillBurst : skill : s.elementActive ? normalBurst : normal,
  } };
});
