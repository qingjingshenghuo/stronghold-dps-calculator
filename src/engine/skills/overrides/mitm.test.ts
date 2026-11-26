import { expect, it } from 'vitest';
import { calculate } from '../../calc.ts';
import operators from '../../../data/generated/operators.json' with {type:'json'};
import bosses from '../../../data/generated/bosses.json' with {type:'json'};
import skills from '../../../data/generated/skills.json' with {type:'json'};
import type { ChessTier, OperatorData, SkillData, BossData, SkillLevelData } from '../../types.ts';
import { timeline } from '../../timeline.ts';
import { generic } from '../generic.ts';
import { mitmOverride } from './char_4147_mitm.ts';

const phys=(a:number,d=1000)=>Math.max(a-d,a*.05);
const target=(tier:ChessTier,slot:number,durationSec:number,bossId='boss_1',bossMechanics?:Record<string,boolean>)=>calculate({
  charId:'char_4147_mitm',tier,skillId:'skchr_mitm_'+slot,bossId,modeId:'mode_single_10',durationSec,bossMechanics,bonds:[],equips:[],
}).totalDamage.value;

function rotation(slot:number,bossId:string,targetHp:number,overrides:Partial<SkillLevelData>={},window=40) {
  const operator=(operators as unknown as OperatorData[]).find(o=>o.name==='渡桥')!,tier=operator.tiers.b;
  const boss=(bosses as unknown as BossData[]).find(o=>o.bossId===bossId)!;
  const skill=(skills as unknown as Record<string,SkillData>)[operator.skillIds[slot-1]!]!;
  const level={...skill.levels['7'],...overrides} as SkillLevelData;
  const base=generic(operator,tier,skill,level,boss);
  return timeline(mitmOverride({operator,tier,skill,level,boss,targetHp},base),level,window,Infinity);
}

it.each([
  ['a',390.7971014492754,246.72463768115944,58,7,3.2,71,.45],
  ['b',491.5189873417722,304.3291139240506,55,8,3.55,68,.6],
] as const)('渡桥%s阶对不可阻挡的胄逐击核算两技能180秒', (tier,a,c,car1,casts,explosion,car2,buff)=>{
  expect(target(tier,1,180)).toBeCloseTo(180*phys(a)+car1*phys(c)+casts*phys(a*explosion),7);
  expect(target(tier,2,180)).toBeCloseTo(135*phys(a)+45*phys(a*(1+buff))+car2*phys(c),7);
});

it('鳍被小车阻挡时只强化本体普攻，自毁后失去强化，真车刷新后恢复',()=>{
  const a=491.5189873417722,d=600;
  const at=(t:number)=>target('b',1,t,'boss_13');
  expect(at(1.01)-at(.99)).toBeCloseTo(phys(a*1.65,d),7);
  expect(at(17.01)-at(16.99)).toBeCloseTo(phys(a*3.55,d)+phys(a,d),7);
  expect(at(18.01)-at(17.99)).toBeCloseTo(phys(a,d),7);
  expect(at(32.01)-at(31.99)).toBeCloseTo(phys(a*1.65,d),7);
  const notBlocked=target('b',1,1.01,'boss_13',{unblocked_shield:true});
  expect(notBlocked).toBeCloseTo(phys(a,d)*.6,7);
});

it('矩兽的初始占用为2挡，只有真车开启二技能才够挡',()=>{
  const a=491.5189873417722;
  const at=(t:number)=>target('b',2,t,'boss_17',{might:false});
  expect(at(1.01)-at(.99)).toBeCloseTo(phys(a),7);
  expect(at(27.01)-at(26.99)).toBeCloseTo(phys(a*1.6*1.65),7);
  const low=rotation(2,'boss_17',1).at!;
  expect(low(27.01)-low(26.99)).toBeCloseTo(phys(a*1.6),7);
});

it('渡桥对矩兽的首开前、技能期和击杀时间不随展示窗口变化', () => {
  const run = (durationSec: number) => calculate({
    charId: 'char_4147_mitm', tier: 'a', skillId: 'skchr_mitm_2', bossId: 'boss_17',
    modeId: 'mode_single_9', cultivation: 2060, potential: 5, bonds: [], equips: [], durationSec,
  });
  // 四级二技能 47−15=32 秒首开，持续15秒。本体每28帧、小车每38帧出手。
  // 开技前分别命中34、25次；技能期小车停攻，本体命中16次并取得阻挡倍率。明力减伤20%。
  const body = phys(429.87681159420293) * .8;
  const car = phys(246.72463768115944) * .8;
  const enhanced = phys(429.87681159420293 * 1.45 * 1.5) * .8;
  const before = 34 * body + 25 * car;
  const long = run(90);
  for (const result of [run(0), run(30), run(32), long]) {
    expect(result.normal.dps).toBeCloseTo(before / 32, 7);
    expect(result.skill!.dps).toBeCloseTo(16 * enhanced / 15, 7);
    expect(result.killTimeSec).toBeCloseTo(long.killTimeSec, 6);
  }
  expect(run(32).totalDamage.value).toBeCloseTo(before, 7);
  expect(run(47).totalDamage.value).toBeCloseTo(before + 16 * enhanced, 7);
});

it('短窗口也能区分 200 秒才首开的技能和从不回复技力的技能', () => {
  const level = { spCost: 200, initSp: 0 };
  const late = rotation(2, 'boss_17', Infinity, level, 1);
  expect(late.firstSkill!.start).toBeCloseTo(200, 8);
  expect(late.firstSkill!.end).toBeCloseTo(215, 8);
  const never = rotation(2, 'boss_17', Infinity, { ...level, increment: 0 }, 1);
  expect(never.firstSkill?.start).toBe(Infinity);
});

it('残骸期间再次施放一技能不产生爆炸，也不推迟真车刷新',()=>{
  const at=rotation(1,'boss_1',Infinity,{spCost:5,initSp:0}).at!;
  const a=491.5189873417722;
  expect(at(5.01)-at(4.99)).toBeCloseTo(phys(a*3.55)+phys(a),7);
  expect(at(10.01)-at(9.99)).toBeCloseTo(phys(a),7);
  expect(at(20.01)-at(19.99)).toBeCloseTo(phys(a*3.55)+phys(a),7);
});

