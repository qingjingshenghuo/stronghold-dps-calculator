import { describe, expect, it } from 'vitest';
import equipsJson from '../data/generated/equips.json' with { type: 'json' };
import bosses from '../data/generated/bosses.json' with { type: 'json' };
import { calculate } from './calc.ts';
import { combineEquips } from './effects/equips.ts';
import { burningCurve } from './equip-curve.ts';
import type { CalcInput, EquipData } from './types.ts';

const equips = equipsJson as EquipData[];
const equip = (name: string, tier = 'a') => equips.find(e => e.name === name && e.tier === tier)!;
const config: CalcInput = {
  charId: 'char_618_acrbot', tier: 'b', skillId: 'skchr_acrbot_1', equips: [], bonds: [],
  bossId: 'boss_1', modeId: 'mode_single_10', durationSec: 10,
};

describe('同一干员携带多份组合材料', () => {
  it.each([
    ['天马之枪', '天马之盔', '天马之耀'],
    ['动能加速器', '动能单手弩', '动能轰击弩'],
    ['驱逐者警棍', '驱逐者瓦斯', '驱逐者防暴装备'],
    ['不退者之盾', '不退者力场', '不退者卫护系统'],
    ['汲取者之心', '汲取者之喙', '汲取者之镰'],
  ])('%s 每次只消耗各一份材料', (first, second, product) => {
    const a = equip(first), b = equip(second), other = equip('维式重锤');
    const result = (slots: typeof equips) => combineEquips(slots).equips.map(e => e.name);
    expect(result([a, other, b, a])).toEqual([product, other.name, first]);
    expect(result([b, b, a])).toEqual([product, second]);
    expect(result([a, b, a, b])).toEqual([product, product]);
  });

  it('暴躁铁皮的两把枪与一顶盔产生一件天马之耀，并保留一把枪的加攻', () => {
    const run = (names: string[]) => calculate({ ...config, equips: names.map(n => equip(n).chessId) });
    const materials = run(['天马之枪', '天马之枪', '天马之盔']);
    const combined = run(['天马之耀', '天马之枪']);
    expect(materials.normal.stats.atk).toBe(combined.normal.stats.atk);
    expect(materials.totalDamage.value).toBe(combined.totalDamage.value);
  });
});

describe('灼燃维式重锤的爆发时刻', () => {
  it.each([180, 360])('史尔特尔黄昏退场后无法击杀胄（%i 秒窗口）', durationSec => {
    const result = calculate({ ...config, charId: 'char_350_surtr', skillId: 'skchr_surtr_3', durationSec,
      equips: [equip('灼燃维式重锤').chessId] });
    expect(result.totalDamage.value).toBeGreaterThan(0);
    const boss = bosses.find(b => b.bossId === config.bossId)!;
    expect(result.totalDamage.value).toBeLessThan(boss.hpByMode.mode_single_10!);
    expect(result.killTimeSec).toBe(Infinity);
  });

  it('部署和锁条结束的法术命中都能爆条，解锁同帧不继承前次减抗', () => {
    // 0、10、20 秒各 20000 法伤。10% 正好达到领袖阈值 2000，爆条的每发按原法抗结算。
    const at = (t: number) => 20000 * (1 + Number(t >= 10) + Number(t >= 20));
    const curve = burningCurve(at, { rate: 0.1, threshold: 2000, lock: 10, burst: 7000, windowGain: 0.25, horizon: 10 });
    expect(curve.at(0)).toBe(27000);
    expect(curve.at(10)).toBeCloseTo(54000, 7);
    expect(curve.at(20)).toBeCloseTo(81000, 7);
    expect(curve.at(360)).toBeCloseTo(81000, 7);
  });
});

it('异阶多功能补剂的每击层数相加，倒换槽位后都在精锐上限停下', () => {
  const bison = { ...config, charId: 'char_325_bison', skillId: 'skcom_def_up[3]', cultivation: 2060, potential: 5 };
  const total = (tiers: string[], stacks: number, durationSec: number) => calculate({ ...bison, durationSec,
    equips: tiers.map(t => equip('多功能补剂', t).chessId), bonds: [{ bondId: 'yanShip', activeChars: 3, stacks }],
  }).totalDamage.value;
  // 普通每击一层、精锐两层。合用八次命中达到 24 层，晚期伤害应等于从开场固定 24 层。
  const mixed = total(['a', 'b'], 0, 90);
  expect(mixed).toBe(total(['b', 'a'], 0, 90));
  expect(mixed).toBeGreaterThan(total(['b'], 0, 90));
  expect(total(['a', 'b'], 0, 180) - mixed).toBeCloseTo(total([], 24, 180) - total([], 24, 90), 7);
});

describe('两面卡西米尔竞技旗', () => {
  it.each([
    ['a', 'a', 1.35 * 1.35],
    ['a', 'b', 1.35 * 1.6],
    ['b', 'b', 1.6 * 1.6],
  ] as const)('普通区间中 %s 与 %s 逐件相乘，包含回技的最后一次普攻', (a, b, scale) => {
    const blue = { ...config, charId: 'char_129_bluep', skillId: 'skchr_bluep_1' };
    const plain = calculate(blue);
    const flags = calculate({ ...blue, equips: [a, b].map(t => equip('卡西米尔竞技旗', t).chessId) });
    // 黑板给出的两阶倍率在前 15 秒内恒定。蓝毒一技能的首轮普攻期及 10 秒窗口均落在这里。
    expect(flags.totalDamage.value).toBeCloseTo(plain.totalDamage.value * scale, 7);
    expect(flags.normal.dps).toBeCloseTo(plain.normal.dps * scale, 7);
  });
});
