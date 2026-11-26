import { expect, it } from 'vitest';
import operators from '../../../data/generated/operators.json' with { type: 'json' };
import equips from '../../../data/generated/equips.json' with { type: 'json' };
import { calculate } from '../../calc.ts';

const items = ['双模机械臂', '源石溶剂'].map(name => equips.find(e => e.name === name && e.tier === 'b')!.chessId);
const crossbow = equips.find(e => e.name === '动能单手弩' && e.tier === 'a')!.chessId;

function againstQuintus(name: string, slot: number) {
  const op = operators.find(o => o.name === name)!;
  const result = calculate({ charId: op.charId, skillId: op.skillIds[slot - 1]!, tier: 'b',
    bossId: 'boss_4', modeId: 'mode_single_10', equips: items, bonds: [] });
  return { result, atk: op.tiers.b.attributes.atk };
}

// 昆图斯 500 防、40 法抗；精锐机械臂 +50% 攻、溶剂 +60% 攻。弱点逐次选择实际伤害类型。
const weakHit = (atk: number) => Math.max(atk - 500, atk * .6);

it.each(['折光', '妮芙'])('%s 一技能转为纯物理后，法伤附带的凋亡损伤为零', name => {
  const { result, atk } = againstQuintus(name, 1);
  // 七级两者均在 18、71、124、177 秒开技，180 秒内技能覆盖 63 秒。
  const skill = atk * 2.9 - 500;
  expect(result.skill!.components[0]!.damageType).toBe('physical');
  expect(result.totalDamage.value).toBeCloseTo((117 * weakHit(atk * 2.1) + 63 * skill) / 1.6, 6);
  if (name === '妮芙') expect(result.elemental!.perSec).toBe(0);
});

it('妮芙二技能的本体与溅射转为物理后均不积累凋亡', () => {
  const { result, atk } = againstQuintus('妮芙', 2);
  // 每14秒一发，首发在第8秒，共13发；0.33秒后的溅射也落在窗口内。
  const expected = 180 * weakHit(atk * 2.1) / 1.6 + 26 * (atk * 2.1 * 3 - 500);
  expect(result.skill!.components[0]!.damageType).toBe('physical');
  expect(result.totalDamage.value).toBeCloseTo(expected, 6);
  expect(result.elemental!.perSec).toBe(0);
});

it('Miss.Christine 一技能转为纯物理后，无神经损伤爆发和麻痹附伤', () => {
  const { result, atk } = againstQuintus('Miss.Christine', 1);
  // 180秒有112次普通或强化攻击。开技区间为 [27,52)、[89,114)、[151,176)。
  const shots = Array.from({ length: 112 }, (_, i) => (i + 1) * 1.6);
  const enhanced = shots.filter(t => t >= 27 && (t - 27) % 62 < 25).length;
  const expected = (112 - enhanced) * weakHit(atk * 2.1) + enhanced * (atk * 2.3 - 500);
  expect(result.skill!.components[0]!.damageType).toBe('physical');
  expect(result.totalDamage.value).toBeCloseTo(expected, 6);
});

it('逻各斯一技能的 CCR-D 只按弩未触发的本体法伤及天赋法伤积累凋亡', () => {
  const result = calculate({ charId: 'char_4133_logos', skillId: 'skchr_logos_1', tier: 'b',
    bossId: 'boss_3', modeId: 'mode_single_10', equips: [items[0]!, crossbow], bonds: [],
    cultivation: 2060, potential: 0, uniEquipId: 'uniequip_002_logos' });
  const atk = result.skill!.stats.atk;
  // 管只有40点有效法抗。本体未触发弩时走法术；触发时物理胜出。60%概率的天赋两种分支均是法伤。
  const artsPerAttack = .7 * (atk + 150) * .6 + .6 * (atk * .6 + 150) * .6 * (1 + .3 * .3);
  const secondsToBurst = 2000 / (artsPerAttack / 1.6 * .08);
  const dot = result.skill!.components.find(c => c.source === 'elemental:necrosis')!;
  expect(dot.dps).toBeCloseTo(800 * 15 / (secondsToBurst + 15), 7);
});

it('黑键对茧的概率物理伤害不提前触发 MSC-D 凋亡爆发', () => {
  const run = (durationSec: number) => calculate({ charId: 'char_4046_ebnhlz', skillId: 'skchr_ebnhlz_2',
    tier: 'b', bossId: 'boss_12', modeId: 'mode_single_10', equips: [items[0]!, crossbow], bonds: [],
    uniEquipId: 'uniequip_004_ebnhlz', durationSec });
  const start = run(46);
  const atk = start.normal.stats.atk;
  // 本体未触发弩时走法术，触发时走物理；倚音独立附带15%攻击力法伤。残影不参与本体损伤积累。
  const directDps = (.7 * atk * .7 + .3 * (atk * 1.3 - 800) + atk * .15 * .7) / 3;
  // 每秒凋亡积累=(.7×A×.7+.15×A×.7)×.08/3，首次爆发在60至61秒之间。
  expect(run(47).totalDamage.value - start.totalDamage.value).toBeCloseTo(directDps, 7);
  expect(run(66).totalDamage.value - run(65).totalDamage.value).toBeCloseTo(directDps + 800, 7);
});
