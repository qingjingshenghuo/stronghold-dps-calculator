import { expect, it } from 'vitest';
import operators from '../data/generated/operators.json' with { type: 'json' };
import bosses from '../data/generated/bosses.json' with { type: 'json' };
import modes from '../data/generated/modes.json' with { type: 'json' };
import bonds from '../data/generated/bonds.json' with { type: 'json' };
import equips from '../data/generated/equips.json' with { type: 'json' };
import { calculate } from './index.ts';
import type { BossData, CalcInput, ChessTier } from './types.ts';

const tiers: ChessTier[] = ['a', 'b'];
const stackLevels = [0, 20, 40, 50, 100, 229];

function checkWindows(input: CalcInput, boss: Pick<BossData, 'hpByMode'>) {
  const hp = boss.hpByMode[input.modeId]!;
  const run = (durationSec: number) => {
    const result = calculate({ ...input, durationSec });
    const total = result.totalDamage.value;
    expect(result.totalDamage.durationSec).toBe(durationSec);
    expect(Number.isFinite(total) && total >= 0, '窗口总伤').toBe(true);
    if (result.cycle) expect(result.cycle.avgDps, '窗口平均 DPS').toBeCloseTo(total / durationSec, 7);
    // 无法击杀允许正无穷；有处决时累计伤害可能小于生命值就已击杀。
    expect(result.killTimeSec, '击杀用时').toBeGreaterThanOrEqual(0);
    // 迅捷的窗口总伤取分支期望，而击杀用时取代表战斗，两者不共用一条曲线。
    if (!input.bonds.some(b => b.bondId === 'swiftShip') && total > hp * (1 + 1e-7)) {
      expect(result.killTimeSec, '已打足目标生命值').toBeLessThanOrEqual(durationSec + 1e-6);
    }
    for (const phase of [result.normal, result.skill]) {
      if (!phase) continue;
      expect(Number.isFinite(phase.dps) && phase.dps >= 0, '阶段 DPS').toBe(true);
      // 阶段平均值与快照可以不同；快照中每个扣血分项的伤害与频率应当自洽。
      for (const component of phase.components) {
        if (!component.countsTowardDps) continue;
        expect(Number.isFinite(component.dps), component.label).toBe(true);
        expect(component.perHit, component.label).toBeGreaterThanOrEqual(0);
        expect(component.hitsPerSec, component.label).toBeGreaterThanOrEqual(0);
        expect(component.dps, component.label).toBeCloseTo(component.perHit * component.hitsPerSec, 7);
      }
    }
    return result;
  };
  const short = run(30), long = run(90);
  expect(long.totalDamage.value + 1e-6, '延长战斗后的累计伤害').toBeGreaterThanOrEqual(short.totalDamage.value);
  // 两栏都描述同一轮开技，观察窗口的终点不应改写这一轮的伤害。
  expect(long.normal.dps, '首次开技前的 DPS').toBeCloseTo(short.normal.dps, 6);
  if (short.skill) expect(long.skill?.dps, '首轮技能 DPS').toBeCloseTo(short.skill.dps, 6);
  else expect(long.skill).toBeNull();
  if (short.killTimeSec === Infinity || long.killTimeSec === Infinity) {
    expect(long.killTimeSec, '窗口长度不改变能否击杀').toBe(short.killTimeSec);
  } else {
    expect(long.killTimeSec, '窗口长度不改变击杀时刻').toBeCloseTo(short.killTimeSec, 5);
  }
}

// 每个干员的每个技能都测试普通与精锐；将 Boss 和规程分摊到用例中，控制常规测试耗时。
const combinations = operators.flatMap(op => op.skillIds.flatMap(skillId =>
  tiers.map(tier => ({ charId: op.charId, name: op.name, skillId, tier }))));
// 指定 DPS_ALL_BOSSES=1 时，同一干员、技能和阶级依次挑战每一只 Boss。
const allBosses = process.env.DPS_ALL_BOSSES === '1';
const rosterCases = combinations.flatMap((row, i) => {
  const targets = allBosses ? bosses : [bosses[(i + Math.floor(i / bosses.length)) % bosses.length]!];
  return targets.map((boss, j) => ({ ...row, boss, modeId: modes[(i + j) % modes.length]!.modeId }));
});
it.each(rosterCases)('$name $tier $skillId 对 $boss.name（$modeId）的伤害与击杀时间', ({ charId, tier, skillId, boss, modeId }) => {
  const input = { charId, tier, skillId, bossId: boss.bossId, modeId, equips: [], bonds: [], cultivation: 2060, potential: 5 };
  checkWindows(input, boss);
});

// 每条装备数据都进入一次实战；轮换所有盟约，优先选成员，绝技等无固有成员的盟约由全场效果受益者承接。
it.each(equips.map((equip, i) => ({
  equip, bond: bonds[i % bonds.length]!, boss: bosses[i % bosses.length]!, i,
})))('$equip.name（$equip.chessId）配合 $bond.name 对 $boss.name 的两个伤害窗口', ({ equip, bond, boss, i }) => {
  const op = operators.find(candidate => candidate.bondIds.includes(bond.bondId)) ?? operators[0]!;
  const activeChars = i % 3 === 0 ? bond.activeCount : bond.powerCount ?? bond.activeCount;
  checkWindows({
    charId: op.charId, tier: tiers[(i + Math.floor(i / bonds.length)) % tiers.length]!, skillId: op.skillIds[0]!,
    bossId: boss.bossId, modeId: 'mode_single_funny', equips: [equip.chessId],
    bonds: [{ bondId: bond.bondId, stacks: stackLevels[i % stackLevels.length]!, activeChars }],
    cultivation: 2060, potential: 5,
  }, boss);
});
