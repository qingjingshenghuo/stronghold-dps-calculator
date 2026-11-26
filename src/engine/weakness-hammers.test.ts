import { describe, expect, it } from 'vitest';
import equipsJson from '../data/generated/equips.json' with { type: 'json' };
import bossesJson from '../data/generated/bosses.json' with { type: 'json' };
import { calculate } from './calc.ts';
import { damage } from './damage.ts';
import { battleEffects } from './effects/common.ts';
import { applyEquips } from './effects/equips.ts';
import { applyGarrisons } from './effects/garrisons.ts';
import { bossAttackInterval } from './effects/boss-attack.ts';
import type { BossData, CalcInput, EquipData } from './types.ts';

const equips = equipsJson as EquipData[];
const bosses = bossesJson as BossData[];
const equip = (name: string, tier = 'a') => equips.find(e => e.name === name && e.tier === tier)!;
const run = (charId: string, skillId: string, tier: 'a' | 'b', names: [string, string?][] = [], extra: Partial<CalcInput> = {}) =>
  calculate({ charId, skillId, tier, equips: names.map(([n, t]) => equip(n, t ?? 'a').chessId), bonds: [], bossId: 'boss_1', modeId: 'mode_single_10', durationSec: 180, ...extra });
const weak = { source: 'test' };

describe('弱点伤害结算', () => {
  it('100 防 / 20 法抗：物理 900 > 法术 800，造成 900 点物理伤害', () => {
    const r = damage({ attack: 1000, type: 'physical', defense: 100, resistance: 20, weakness: weak });
    expect(r.perHit).toBeCloseTo(900, 10);
    expect(r.type).toBe('physical');
    expect(r.derivation[0]).toMatchObject({ label: '弱点伤害：按物理伤害结算的单段伤害', value: 900 });
    expect(r.derivation[1]).toMatchObject({ label: '弱点伤害：按法术伤害结算的单段伤害', value: 800 });
    expect(r.derivation[2]!.label).toContain('造成物理伤害');
  });
  it('500 防 / 10 法抗：物理 500 < 法术 900，造成 900 点法术伤害（原类型为物理也一样）', () => {
    for (const type of ['physical', 'arts'] as const) {
      const r = damage({ attack: 1000, type, defense: 500, resistance: 10, weakness: weak });
      expect(r.perHit).toBeCloseTo(900, 10);
      expect(r.type).toBe('arts');
      expect(r.derivation[2]!.label).toContain('造成法术伤害');
    }
  });
  it('两种算法都走完整流程：各自的减防/减抗、穿透、保底与按类型生效的增伤', () => {
    // 物理：防 100 −固定穿透 50 → 有效 50，伤害 950；法术：法抗 20，仅法术增伤 +20% → 800 × 1.2 = 960，取法术。
    const r = damage({ attack: 1000, type: 'physical', defense: 100, resistance: 20,
      modifiers: [{ group: '法术增伤', kind: 'increase', value: 0.2, types: ['arts'] }],
      weakness: { source: 'test', byType: { physical: { penetrationFixed: 50 }, arts: {} } } });
    expect(r.perHit).toBeCloseTo(960, 10);
    expect(r.type).toBe('arts');
    // 两种都打在 5% 保底上时相等，保持原类型。
    const floor = damage({ attack: 100, type: 'physical', defense: 1000, resistance: 100, weakness: weak });
    expect(floor.perHit).toBeCloseTo(5, 10);
    expect(floor.type).toBe('physical');
  });
  it('真实伤害不转换', () => {
    const r = damage({ attack: 1000, type: 'true', defense: 0, resistance: 0, weakness: weak });
    expect(r).toMatchObject({ perHit: 1000, type: 'true' });
  });
  it('卫戍特质「弱点伤害」：按特质给出弱点伤害标记，不再记为未建模', () => {
    for (const id of ['garrison_131_b', 'garrison_75_b', 'garrison_176_b', 'garrison_140_b']) {
      const e = battleEffects();
      applyGarrisons(e, [id], []);
      expect(e.weakness?.source, id).toBe(`garrison:${id}`);
      expect(e.notes.join(''), id).not.toContain('未建模');
    }
  });
});

describe('弱点伤害：干员与装备（boss_1：1000 防 / 25 法抗）', () => {
  // 面板攻击力 A 远低于 1000 防：物理只剩 5% 保底 0.05A；法术 A × (1 − 0.25) = 0.75A，取法术。
  const check = (name: string, r: ReturnType<typeof run>, scale = 1) => {
    const attack = r.normal.components[0]!;
    const A = r.normal.stats.atk * scale;
    expect(attack.damageType, name).toBe('arts');
    expect(attack.perHit, name).toBeCloseTo(0.75 * A, 8);
    expect(attack.derivation.find(s => s.label === '弱点伤害：按物理伤害结算的单段伤害')!.value, name).toBeCloseTo(0.05 * A, 8);
    expect(attack.derivation.find(s => s.label === '弱点伤害：按法术伤害结算的单段伤害')!.value, name).toBeCloseTo(0.75 * A, 8);
    return attack;
  };
  it('杰克（进阶 S1）：A = 519.72，法术 389.79，攻击间隔 0.7667 秒 → 普攻 DPS 508.43', () => {
    const r = run('char_347_jaksel', 'skchr_jaksel_1', 'b');
    expect(r.normal.stats.atk).toBeCloseTo(519.7246, 3);
    const attack = check('杰克', r);
    expect(attack.perHit).toBeCloseTo(389.7935, 3);
    expect(r.normal.dps).toBeCloseTo(389.7935 / 0.766667, 1);
  });
  it('伺夜（进阶 S1）：攻击狼群阻挡的 Boss 为 150%，狼群独立走物理防御', () => {
    const r = run('char_427_vigil', 'skchr_vigil_1', 'b');
    expect(r.normal.stats.atk).toBeCloseTo(453.6854, 3);
    const owner = 453.685393258427 * 1.5 * .75;
    expect(check('伺夜', r, 1.5).perHit).toBeCloseTo(owner, 7);
    // 开技前两只狼影，独立攻击力 348.416，175 穿防后仍走 5% 保底，1.25 秒取整为 38 帧。
    expect(r.normal.dps).toBeCloseTo(owner + 2 * 348.4157303370786 * .05 / (38 / 30), 6);
  });
  it('水灯心（进阶 S1）：周围八格内目标触发模组 110%，逐类型计算弱点', () => {
    const r = run('char_4177_brigid', 'skchr_brigid_1', 'b');
    expect(r.normal.stats.atk).toBeCloseTo(627.1139, 3);
    expect(check('水灯心', r, 1.1).perHit).toBeCloseTo(627.1139240506329 * 1.1 * .75, 8);
  });
  it('双模机械臂（灰喉进阶 S2，精锐阶 +50%）：A = 501.68 × 1.5 = 752.53，物理 37.63 → 法术 564.39', () => {
    const base = run('char_367_swllow', 'skchr_swllow_2', 'b');
    const arm = run('char_367_swllow', 'skchr_swllow_2', 'b', [['双模机械臂', 'b']]);
    expect(base.normal.components[0]!.damageType).toBe('physical');
    expect(arm.normal.stats.atk).toBeCloseTo(base.normal.stats.atk * 1.5, 8);
    expect(check('双模机械臂', arm).perHit).toBeCloseTo(564.3940, 3);
    expect(arm.assumptions!.join('')).not.toContain('未知');
  });
  it('灼燃积累按实际取到的类型：转为法术后，灼燃维式重锤的灼燃条开始积累', () => {
    // 灰喉原为物理，单带灼燃重锤只有攻击力加成；带双模机械臂后普攻转为法术，灼燃损伤随之积累并爆发（每次 7000）。
    const arm = run('char_367_swllow', 'skchr_swllow_2', 'b', [['双模机械臂', 'b']]);
    const both = run('char_367_swllow', 'skchr_swllow_2', 'b', [['双模机械臂', 'b'], ['灼燃维式重锤', 'b']]);
    const scale = both.normal.stats.atk / arm.normal.stats.atk; // (1 + 0.5 + 0.5) / 1.5
    expect(both.totalDamage.value).toBeGreaterThan(arm.totalDamage.value * scale + 2 * 7000);
  });
});

describe('终极维式重锤按场上重锤计算（慕斯进阶 S2，boss_1）', () => {
  const mousse = (fieldHammers?: string[], names: [string, string?][] = [['终极维式重锤']]) => run('char_185_frncat', 'skchr_frncat_2', 'b', names, { fieldHammers });
  const all = ['灼燃维式重锤', '坚固维式重锤', '加速维式重锤', '战栗维式重锤', '电流维式重锤'];
  it('0 种：不加攻击力、不继承特殊效果，与不带装备相同', () => {
    const base = mousse(undefined, []);
    const none = mousse([]);
    expect(none.totalDamage.value).toBeCloseTo(base.totalDamage.value, 6);
    expect(none.normal.stats.atk).toBeCloseTo(base.normal.stats.atk, 8);
    expect(none.assumptions!.join('')).toContain('场上没有带特殊效果的维式重锤');
    // 每 38 帧判一次 20% 二连击，攻击序号从 0 开始；[50,90)、[170,180) 切入 1.45A。
    // 分段积分合计 192.255263 倍普通法术单段。
    expect(base.totalDamage.value).toBeCloseTo(626.6086956521739 * .75 * 192.255263157895, 6);
  });
  it('只选加速：攻击力 +20%，攻速 +30，无穿透、无灼燃', () => {
    const base = mousse(undefined, []);
    const fast = mousse(['加速维式重锤']);
    // A = 626.6 × 1.2 = 751.9；攻击间隔 1.25 / 1.3 → 29 帧 0.9667 秒（无装备 38 帧 1.2667 秒）；法抗 25 无穿透。
    expect(fast.normal.stats.atk).toBeCloseTo(base.normal.stats.atk * 1.2, 8);
    expect(fast.normal.stats.attackInterval).toBeCloseTo(29 / 30, 8);
    expect(fast.normal.components[0]!.perHit).toBeCloseTo(fast.normal.stats.atk * 0.75, 8);
    expect(fast.notes.join('')).not.toContain('灼燃');
    expect(fast.assumptions!.join('')).toContain('按场上 1 种带特殊效果的维式重锤计算（加速维式重锤）');
    // 换作每 29 帧一次，非技能攻击为 1.2A，技能时为 1.65A，20% 连击仍逐次判定。
    expect(fast.totalDamage.value).toBeCloseTo(139523.609145427, 6);
  });
  it('选全部 5 种：攻击力 +100%，攻速 +30，30% 穿透，灼燃，与缺省相同', () => {
    const base = mousse(undefined, []);
    const five = mousse(all);
    // A = 626.6 × 2 = 1253.2；有效法抗 25 × 0.7 = 17.5，单段 A × 0.825 = 1033.9。
    expect(five.normal.stats.atk).toBeCloseTo(base.normal.stats.atk * 2, 8);
    expect(five.normal.components[0]!.perHit).toBeCloseTo(five.normal.stats.atk * 0.825, 8);
    // 逐击分段积分：每 29/30 秒判一次二连击，[50,90)、[170,180) 的攻击力为 2.45A，其余为 2A。
    // 累计 20000 法伤触发爆发，跳过随后 10 秒再积累。七次越过阈值的时刻独立用有理数积分求出。
    const triggers = [15.149672131, 40.949016392, 63.996136943, 87.327574435, 113.126918697, 138.926262958, 163.818536844];
    const at = (durationSec: number) => run('char_185_frncat', 'skchr_frncat_2', 'b', [['终极维式重锤']], { fieldHammers: all, durationSec }).totalDamage.value;
    for (const t of triggers) {
      const jump = at(t + .0001) - at(t - .0001);
      // 0.0002 秒内的连续法伤不足 1 点；爆条扣 7000 点。
      expect(jump).toBeGreaterThan(7000);
      expect(jump).toBeLessThan(7001);
    }
    // 逐击基础合计 246199.3641。锁条时法术倍率从 .825 变为 .965，七段共增加 16217.4822。
    // 每次求根精度为 1e-8 秒；将每段边界的时间误差折成伤害后，校验到万分位。
    expect(five.totalDamage.value).toBeCloseTo(246199.364122938 + 7 * 7000 + 16217.482239971, 4);
    expect(mousse().totalDamage.value).toBeCloseTo(five.totalDamage.value, 6);
    expect(five.assumptions!.join('')).toContain('按场上 5 种');
    expect(mousse().assumptions!.join('')).toContain('默认场上有 5 种');
  });
  it('只继承选中的效果：没选电流就没有对麻痹目标的穿透', () => {
    const e = battleEffects();
    applyEquips(e, [equip('终极维式重锤')], 0, { boss: bosses.find(b => b.bossId === 'boss_1'), fieldHammers: ['灼燃维式重锤', '坚固维式重锤'] });
    expect(e.stats).toEqual([expect.objectContaining({ stat: 'atk', value: 0.4 })]);
    expect(e.resPenetrationPct).toBe(0);
    expect(e.burning?.ratio).toBeCloseTo(0.1, 10);
  });
});

describe('受击回复技力', () => {
  it('Boss 攻击间隔取自 enemy_database：胄 4 秒；铳攻速未定义按 100，4.5 秒', () => {
    expect(bossAttackInterval(bosses.find(b => b.bossId === 'boss_1')!).interval).toBe(4);
    expect(bossAttackInterval(bosses.find(b => b.bossId === 'boss_2')!).interval).toBe(4.5);
    expect(bossAttackInterval({ attributeSource: [] }).source).toContain('缺少攻击间隔');
  });
  it('斥罪进阶 S3：受击时钟在30秒技能期间继续走，浓茶不改变下轮充能', () => {
    const r = run('char_4065_judge', 'skchr_judge_3', 'b');
    // 胄每4秒攻击，首次开技在96秒，126秒结束；新一轮第1击在128秒，第24击在220秒。
    expect(r.cycle!.spRecoverSec).toBeCloseTo(220 - 126, 8);
    expect(r.assumptions).toContain('【受击回复】默认 Boss 持续攻击该干员，按 Boss 攻击间隔回复技力');
    expect(r.notes.join('')).toContain('每 4 秒命中一次，每次受击回复 1 点');
    expect(r.normal.components[0]!.derivation.some(s => s.label.startsWith('受击回复技力'))).toBe(true);
    const tea = run('char_4065_judge', 'skchr_judge_3', 'b', [['萨尔贡浓茶']]);
    expect(tea.cycle!.spRecoverSec).toBeCloseTo(220 - 126, 8);
    // 铳首次开技在108秒，138秒结束；139.5秒再次受击，第二轮第24击在243秒。
    expect(run('char_4065_judge', 'skchr_judge_3', 'b', [], { bossId: 'boss_2' }).cycle!.spRecoverSec).toBeCloseTo(243 - 138, 8);
  });
});
