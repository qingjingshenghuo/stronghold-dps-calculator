import { expect, it } from 'vitest';
import operators from '../data/generated/operators.json';
import { calculate } from './calc.ts';
import type { CalcInput } from './types.ts';
const op = operators.find(o=>o.name==='蓝毒')!;
const input: CalcInput = {charId:op.charId,tier:'b',skillId:op.skillIds[1],equips:[],bonds:[],bossId:'boss_1',modeId:'mode_single_10',durationSec:30};
it('无条件装备接入calculate面板和来源，超槽只取前N件', () => {
  const equip = 'chess_item_1_01_e_a';
  const base = calculate(input);
  const equipped = calculate({...input,equips:[equip]});
  // 重锤+15%进入同一个百分比区，新增面板=基础ATK×.15，不重复乘天赋/技能。
  expect(equipped.normal.stats.atk-base.normal.stats.atk).toBeCloseTo(op.tiers.b.attributes.atk*.15);
  expect(equipped.skill!.stats.atk-base.skill!.stats.atk).toBeCloseTo(op.tiers.b.attributes.atk*.15);
  expect(equipped.normal.stats.derivation.atk.some(s=>s.source===`equip:${equip}`)).toBe(true);
  const slots=op.tiers.b.equipSlotNum;
  const valid=calculate({...input,equips:Array(slots).fill(equip)});
  const overflow=calculate({...input,equips:Array(slots+1).fill(equip)});
  expect(overflow.normal.dps).toBe(valid.normal.dps);
  expect(overflow.notes.some(n=>n.includes('只取前'))).toBe(true);
});
it('重复盟约配置不重复施加且记录取最后一项', () => {
  const o=operators.find(x=>x.bondIds.includes('yanShip'))!;
  const config={...input,charId:o.charId,skillId:o.skillIds[0]};
  const s={bondId:'yanShip',stacks:10,activeChars:3};
  const one=calculate({...config,bonds:[s]});
  const two=calculate({...config,bonds:[{...s,stacks:0},s]});
  expect(two.normal.stats.atk).toBe(one.normal.stats.atk);
  expect(two.notes.some(n=>n.includes('重复盟约'))).toBe(true);
});
it('夕由装备取得卡西米尔，部署与开技后30秒窗口内真伤仅随本体攻击，召唤物沿用原时间轴', () => {
  const config = { ...input, charId: 'char_2015_dusk', skillId: 'skchr_dusk_3', equips: ['chess_item_6_03_e_a', 'chess_item_4_04_e_a'] };
  const at = (activeChars: number, durationSec: number) => calculate({ ...config, durationSec, bonds: [{ bondId: 'kazimierzShip', stacks: 0, activeChars }] });
  const before = at(3, 40), after = at(6, 40);
  // S3在49秒开启。尽管开场的小自在参与攻击，只有夕的本体攻击附带65%真伤，且只在部署后30秒窗口内。
  const normal = before.normal.stats.atk * .65 / before.normal.stats.attackInterval;
  // 竞技旗（普通）同时放大前 19 秒的伤害：15×0.35 + 0.5×Σ_{k=1..8}(0.35−0.04k) = 5.25 + 0.68 = 5.93 秒等效。
  const flag = 5.93;
  expect(after.totalDamage.value - before.totalDamage.value).toBeCloseTo((30 + flag) * normal);
  const summon = before.skill!.components.find(c => c.source.startsWith('token:'));
  expect(summon).toBeDefined();
  expect(after.skill!.components.find(c => c.source.startsWith('token:'))).toEqual(summon);
  expect(after.normal.components.find(c => c.source === 'bond:kazimierzShip')?.dps).toBeCloseTo(normal);
  const skill = before.skill!.stats.atk * .65 / before.skill!.stats.attackInterval;
  // 49秒开技再开30秒窗口：[49,79) 技能攻击附带真伤，79秒后技能仍在持续但窗口已关。
  expect(at(6, 82).totalDamage.value - at(3, 82).totalDamage.value).toBeCloseTo((30 + flag) * normal + 30 * skill);
});
it('史尔特尔获授萨尔贡，黄昏退场后流沙地面继续跳伤，技能秒伤随退场结束', () => {
  const config = { ...input, charId: 'char_350_surtr', skillId: 'skchr_surtr_3', equips: ['chess_item_6_03_e_a', 'chess_item_2_04_e_a'] };
  const at = (activeChars: number, durationSec: number) => calculate({ ...config, durationSec, bonds: [{ bondId: 'sargonShip', stacks: 0, activeChars }] });
  const after = at(6, 65), before = at(3, 65);
  // 黄昏6.957秒开技（8/1.15），存活sqrt(600)+9秒，共33次技能秒伤。65秒内流沙已跳11次。
  expect(after.skill!.components.find(c => c.source === 'bond:sargonShip:mag_damage_2')?.dps).toBe(600);
  expect(after.totalDamage.value - before.totalDamage.value).toBeCloseTo(33 * 600 + 11 * 3750);
  expect(at(6, 70).totalDamage.value - after.totalDamage.value).toBeCloseTo(3750);
  expect(before.killTimeSec).toBe(Infinity);
  expect(Number.isFinite(after.killTimeSec)).toBe(true);
  expect(after.cycle).toBeNull();
});
it('六卡西米尔玛恩纳再由装备取得萨尔贡，原真伤与技能分项各保留一份', () => {
  const config = { ...input, charId: 'char_4064_mlynar', skillId: 'skchr_mlynar_3', equips: ['chess_item_6_03_e_a', 'chess_item_2_04_e_a'] };
  const at = (activeChars: number) => calculate({ ...config, durationSec: 30, bonds: [
    { bondId: 'kazimierzShip', stacks: 0, activeChars: 6 }, { bondId: 'sargonShip', stacks: 0, activeChars },
  ] });
  const before = at(3), after = at(6);
  // 25/1.15秒开技。到30秒经过8个整秒和1个5秒周期，卡西米尔两种真伤保持原值。
  expect(after.skill!.components.filter(c => !c.source.startsWith('bond:sargonShip:')).map(c => [c.source, c.dps]))
    .toEqual(before.skill!.components.map(c => [c.source, c.dps]));
  expect(after.totalDamage.value - before.totalDamage.value).toBeCloseTo(8 * 600 + 3750);
});
it.each([
  ['char_293_thorns', 'skchr_thorns_3', 'uniequip_003_thorns'],
  ['char_4133_logos', 'skchr_logos_3', 'uniequip_002_logos'],
])('没有可加层的所属盟约时，补剂保留 %s 的元素模组和技能输出', (charId, skillId, uniEquipId) => {
  for (const bonds of [[], [{ bondId: 'arcaneShip', activeChars: 1, stacks: 40 }],
    [{ bondId: 'suntShip', activeChars: 2, stacks: 40 }]]) {
    const config = { ...input, charId, skillId, uniEquipId, durationSec: 180, bonds };
    const base = calculate(config);
    for (const equip of ['chess_item_3_13_e_a', 'chess_item_3_13_e_b']) {
      const tonic = calculate({ ...config, equips: [equip] });
      expect(tonic.model).toBe('override');
      expect(tonic.totalDamage).toEqual(base.totalDamage);
      expect(tonic.killTimeSec).toBe(base.killTimeSec);
    }
  }
});
it('多功能补剂按实际伤害逐层增加已激活盟约，不在开场叠满', () => {
  const o=operators.find(x=>x.charId==='char_4133_logos')!;
  const config={...input,charId:o.charId,skillId:o.skillIds[o.defaultSkillIndex],bonds:[{bondId:'arcaneShip',stacks:0,activeChars:2}]};
  const base=calculate(config);
  const ramp=calculate({...config,equips:['chess_item_3_13_e_a']});
  const full=calculate({...config,bonds:[{bondId:'arcaneShip',stacks:12,activeChars:2}]});
  // 首次完整普攻在基础间隔末段才为补剂加层，之前的半个间隔没有额外层数。
  const opening = { ...config, durationSec: base.normal.stats.attackInterval / 2 };
  expect(calculate({ ...opening, equips: ['chess_item_3_13_e_a'] }).totalDamage.value).toBeCloseTo(calculate(opening).totalDamage.value, 8);
  // 非技能期 DPS 包括首次开技前的整个区间，逐步叠层后应高于零层阶段。
  expect(ramp.normal.dps).toBeGreaterThan(base.normal.dps);
  expect(ramp.totalDamage.value).toBeGreaterThan(base.totalDamage.value);
  expect(ramp.totalDamage.value).toBeLessThan(full.totalDamage.value);
  expect(ramp.accuracy).toBe('approx');
});
it('多功能补剂不重新计算部署时卫戍特质的层数快照', () => {
  const o=operators.find(x=>x.charId==='char_4064_mlynar')!;
  const interval = 43/30;
  const config={...input,charId:o.charId,skillId:o.skillIds[1],durationSec:20 + 2*interval,bonds:[{bondId:'kazimierzShip',stacks:4,activeChars:3}]};
  const base=calculate(config);
  const ramp=calculate({...config,equips:['chess_item_3_13_e_a']});
  // 首次S2于20秒开启。第一击双段使补剂增加2层，跨过5层只提高持续加攻上限2%。
  // 第二击额外物伤=部署基础攻击×.02×1.6×1.1×2，部署特质的20点基础攻击不补发。
  expect(ramp.totalDamage.value-base.totalDamage.value).toBeCloseTo(354.7977528089888*.02*1.6*1.1*2, 8);
});
