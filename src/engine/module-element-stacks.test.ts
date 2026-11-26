import { expect, it } from 'vitest';
import { calculate, type CalcInput } from './index.ts';

const supplement = 'chess_item_3_13_e_a';
const advanced = 'chess_item_3_13_e_b';
const hammer = 'chess_item_1_01_e_a';
const thorns: CalcInput = {
  charId: 'char_293_thorns', skillId: 'skchr_thorns_3', uniEquipId: 'uniequip_003_thorns', tier: 'b',
  bossId: 'boss_1', modeId: 'mode_single_funny', equips: [], bonds: [{ bondId: 'iberiaShip', activeChars: 3, stacks: 0 }],
};
const logos: CalcInput = {
  ...thorns, charId: 'char_4133_logos', skillId: 'skchr_logos_3', uniEquipId: 'uniequip_002_logos',
  bonds: [{ bondId: 'arcaneShip', activeChars: 2, stacks: 0 }],
};
const total = (input: CalcInput, durationSec: number) => calculate({ ...input, durationSec }).totalDamage.value;

it.each([{ equips: [] }, { equips: [hammer] }])('棘刺 LOR-D 补剂在命中后加层，神经条跨过首轮开技（额外装备 $equips）', ({ equips }) => {
  const base = { ...thorns, equips }, withItem = { ...base, equips: [supplement, ...equips] };
  const reference = calculate(base);
  const stacked = calculate({ ...base, bonds: [{ ...base.bonds[0]!, stacks: 12 }] });
  const actual = calculate(withItem);
  expect(actual.model).toBe('override');
  const { attackInterval } = reference.normal.stats;
  const firstCast = 15 * attackInterval;
  const initial = reference.normal.dps, full = stacked.normal.dps;
  // 直到首开，每秒中毒一次、每攻击间隔普攻一次。伊比利亚每层的法伤增量相同，12 次后封顶。
  const events = Array.from({ length: 12 }, (_, i) => i + 1).flatMap(n => [n, n * attackInterval])
    .sort((a, b) => a - b).slice(0, 12);
  const openingDamage = initial * firstCast + events.reduce((n, t) => n + (firstCast - t) * (full - initial) / 12, 0);
  expect(total(withItem, 0.5)).toBeCloseTo(total(base, 0.5), 7);
  expect(total(withItem, firstCast)).toBeCloseTo(openingDamage, 5);
  // 领袖阈值 2000，LOR-D 将物理及法术伤害的 10% 转为神经损伤。首开后补足剩余部分，当场扣 6000。
  const skillDps = stacked.skill!.components.filter(c => c.damageType === 'physical' || c.damageType === 'arts').reduce((n, c) => n + c.dps, 0);
  const trigger = firstCast + (20000 - openingDamage) / skillDps;
  expect(trigger).toBeGreaterThan(firstCast);
  expect(total(withItem, trigger - .001)).toBeCloseTo(20000 - skillDps * .001, 5);
  expect(total(withItem, trigger + .001)).toBeCloseTo(26000 + skillDps * .001, 5);
});

it.each([['arcaneShip', supplement, 12], ['visiShip', advanced, 24]] as const)(
  '逻各斯 CCR-D 携带补剂时保留语汇演化，%s 的伤害和攻速达到对应上限', (bondId, equip, cap) => {
    const base = { ...logos, bonds: [{ bondId, activeChars: 2, stacks: 0 }] };
    const withItem = { ...base, equips: [equip] };
    const stacked = { ...base, bonds: [{ bondId, activeChars: 2, stacks: cap }] };
    expect(calculate(withItem).model).toBe('override');
    expect(total(withItem, 1)).toBeCloseTo(total(base, 1), 7);
    // 20 秒时两组都已满临时层数，尚未开 S3 或触发凋亡；此处的真实斜率应等于预置满层的普通伤害率。
    expect(total(withItem, 20.1) - total(withItem, 20)).toBeCloseTo(total(stacked, 20.1) - total(stacked, 20), 6);
  },
);

it('补剂只改变已激活的所属盟约，额外的绝技全场增益保留初始效果', () => {
  const team = { bondId: 'suntShip', activeChars: 5, stacks: 40 };
  const base = { ...logos, bonds: [...logos.bonds, team] };
  const withItem = { ...base, equips: [supplement] };
  expect(total(withItem, 1)).toBeCloseTo(total(base, 1), 7);
  const stacked = { ...base, bonds: [{ ...logos.bonds[0]!, stacks: 12 }, team] };
  expect(total(withItem, 10.1) - total(withItem, 10)).toBeCloseTo(total(stacked, 10.1) - total(stacked, 10), 6);
});

it('逻各斯远见进阶补剂按首开前后已满的 24 层展示面板', () => {
  const result = calculate({ ...logos, equips: [advanced], bonds: [{ bondId: 'visiShip', activeChars: 2, stacks: 0 }] });
  // 精锐卫戍每 3 层给 2 攻速；1.6 秒基础间隔在 116 攻速下取整为 41 帧。
  for (const phase of [result.normal, result.skill!]) {
    expect(phase.stats.attackSpeed).toBe(116);
    expect(phase.stats.attackInterval).toBeCloseTo(41 / 30, 8);
    expect(phase.components[0]!.hitsPerSec).toBeCloseTo(30 / 41, 8);
  }
});

it.each([thorns, logos])('$charId 的补剂与炎国短刀合用时，保留初始盟约、专属模组和短刀叠层', input => {
  const blade = 'chess_item_3_03_e_a';
  const base = { ...input, bonds: [{ ...input.bonds[0]!, stacks: 40 }], durationSec: 90 };
  const single = calculate({ ...base, equips: [blade] });
  const result = calculate({ ...base, equips: [supplement, blade] });
  expect(result.model).toBe('override');
  expect(result.totalDamage).toEqual(single.totalDamage);
  expect(result.killTimeSec).toBe(single.killTimeSec);
  expect(result.elemental).toEqual(single.elemental);
  expect(result.accuracy).toBe('approx');
  expect(result.notes.join('')).toContain('仅忽略多功能补剂在战斗中新增的盟约层数');
});
