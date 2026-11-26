import { actionModel, duelAttack } from './duel-attack.ts';
import { duelClock } from './duel-clock.ts';
import { actionDamage } from './shared.ts';
import { artsFraction, damage } from '../../damage.ts';
import { bossAttackInterval } from '../../effects/boss-attack.ts';
import { necrosisProfile } from '../../effects/elemental.ts';

// https://prts.wiki/w/Miss.Christine ：每次麻痹实际打断普攻时才产生天赋元素伤害。
export const override = actionModel(['只计自身造成的神经损伤；麻痹在 Boss 下一次普攻时消耗，二技能的感知灵体单独按秒命中。'],(ctx,model)=>{
  const e=model.battle!, b=ctx.level.blackboard.nums, one=ctx.skill.skillId.endsWith('_1');
  const normal=duelAttack(ctx,e,false,'arts');
  const skill=duelAttack(ctx,one?e:{ ...e, extraHits:[], splash:undefined, atkProc:undefined },true,'arts',b.atk,0,
    one?{}:{ ownerActions:0, fixedInterval:b.interval, scale:b.atk_scale });
  const profile=necrosisProfile(ctx.boss);
  const elemental=(attack:number)=>damage({attack,type:'elemental',target:ctx.boss,epDamageResistance:ctx.boss.attributes?.epDamageResistance}).perHit;
  const attackClock=bossAttackInterval(ctx.boss).interval;
  let nextBoss=attackClock, gauge=0, stacks=0, unlock=0;
  const amplify=ctx.tier.trait?.blackboard.nums.damage_scale??1;
  return duelClock(ctx,model,{normal,skill,length:()=>ctx.level.duration,panel:st=>st.active?skill:normal,
    nextEvent:()=>nextBoss,event:st=>{nextBoss+=attackClock;if(stacks<=0)return 0;stacks--;
      return elemental((st.active?skill:normal).stats.atk*ctx.tier.talents[0]!.blackboard.nums.atk_scale!)*(st.time<unlock?amplify:1);},
    shot:(st,p)=>{
      const value=actionDamage(p);
      if(st.time<unlock)return value*amplify;
      if(one&&st.active){
        const hit=p.components[0]!;
        gauge+=hit.perHit*artsFraction(hit)*b['attack@ep_damage_ratio']!*profile.buildupMultiplier;
        if(gauge>=profile.threshold){gauge=0;unlock=st.time+10;stacks=ctx.boss.attributes?.immunities.palsyImmune?0:3;return value+elemental(6000);}
      }
      return value;
    }});
});
