import { describe, expect, it } from 'vitest';
import equipsJson from '../data/generated/equips.json' with { type: 'json' };
import bossesJson from '../data/generated/bosses.json' with { type: 'json' };
import operatorsJson from '../data/generated/operators.json' with { type: 'json' };
import { calculate } from './calc.ts';
import { damage } from './damage.ts';
import { battleEffects } from './effects/common.ts';
import { applyEquips, combineEquips, equipCoverage, splashPerAttack } from './effects/equips.ts';
import { artsShare, burningCurve, scaledCurve } from './equip-curve.ts';
import { generic } from './skills/generic.ts';
import { sequenceSuccesses, swiftDraw, swiftSucceeds } from './swift.ts';
import type { BondSetting, BossData, EquipData, OperatorData, PhaseResult, SkillData, SkillLevelData } from './types.ts';

const equips = equipsJson as EquipData[];
const bosses = bossesJson as BossData[];
const equip = (name: string, tier = 'a') => equips.find(e => e.name === name && e.tier === tier)!;
const boss = (id: string) => bosses.find(b => b.bossId === id)!;
const apply = (name: string, tier = 'a', context: Parameters<typeof applyEquips>[3] = {}) => {
  const e = battleEffects(); applyEquips(e, [equip(name, tier)], 0, context); return e;
};
const calc = (charId: string, skillId: string, tier: 'a' | 'b', names: [string, string?][], bossId = 'boss_1', bonds: BondSetting[] = []) =>
  calculate({ charId, skillId, tier, equips: names.map(([n, t]) => equip(n, t ?? 'a').chessId), bonds, bossId, modeId: 'mode_single_10', durationSec: 180 });
// 慕斯、深靛和灰喉覆盖法术、持续伤害与物理多段攻击。
const mousse = (names: [string, string?][], bossId = 'boss_1', tier: 'a' | 'b' = 'b', bonds: BondSetting[] = []) => calc('char_185_frncat', 'skchr_frncat_2', tier, names, bossId, bonds);
const indigo = (names: [string, string?][], bossId = 'boss_1', tier: 'a' | 'b' = 'a') => calc('char_469_indigo', 'skchr_indigo_2', tier, names, bossId);

describe('固定判定序列', () => {
  it('黄金分割序列：起点 0.5，第二条序列错开 √2−1', () => {
    // u_k = frac(0.5 + 0.6180339887k)：u_0 = 0.5，u_1 = 0.1180，u_2 = 0.7361。
    expect(swiftDraw(0)).toBe(0.5);
    expect(swiftDraw(1)).toBeCloseTo(0.1180339887, 9);
    expect(swiftDraw(2)).toBeCloseTo(0.7360679775, 9);
    expect(swiftDraw(0, 1)).toBeCloseTo(0.9142135624, 9);
    // 概率 0.34：前两次判定 0.5 失败、0.118 成功，不再出现前两次都失败。
    expect([0, 1].map(k => swiftSucceeds(k, 0.34))).toEqual([false, true]);
  });
  it('概率越高成功不减；前 n 次成功次数与 概率×n 相差不超过 2', () => {
    for (let k = 0; k < 2000; k++) if (swiftSucceeds(k, 0.3)) expect(swiftSucceeds(k, 0.6)).toBe(true);
    for (let p = 0.01; p < 1; p += 0.01) for (const n of [5, 10, 50, 180, 1000, 2000]) {
      expect(Math.abs(sequenceSuccesses(n, p) - p * n)).toBeLessThanOrEqual(2);
      expect(Math.abs(sequenceSuccesses(n, p, 1) - p * n)).toBeLessThanOrEqual(2);
    }
    expect(sequenceSuccesses(100, 1)).toBe(100);
    expect(sequenceSuccesses(100, 0)).toBe(0);
  });
});

describe('精准狙击镜', () => {
  it('默认目标在 3 格以外，伤害 ×1.3/×1.5，并写明假设', () => {
    expect(apply('精准狙击镜').modifiers[0]).toMatchObject({ kind: 'increase' });
    expect(apply('精准狙击镜').modifiers[0]?.value).toBeCloseTo(0.3, 10);
    expect(apply('精准狙击镜', 'b').modifiers[0]?.value).toBeCloseTo(0.5);
    expect(apply('精准狙击镜', 'b').assumptions[0]).toContain('3 格及以上');
    // 灰喉物理：增伤在防御之后，进阶阶段面板 DPS 整体 ×1.5。
    const base = calc('char_367_swllow', 'skchr_swllow_2', 'b', []);
    const scoped = calc('char_367_swllow', 'skchr_swllow_2', 'b', [['精准狙击镜', 'b']]);
    expect(scoped.normal.dps).toBeCloseTo(base.normal.dps * 1.5, 8);
    expect(scoped.skill!.dps).toBeCloseTo(base.skill!.dps * 1.5, 8);
  });
  it('与维多利亚/谢拉格盟约增伤分区相乘', () => {
    // 法术 1000、法抗 0：维多利亚 1.25 × 谢拉格 1.35 × 狙击镜 1.5。
    const e = apply('精准狙击镜', 'b');
    const modifiers = [
      ...e.modifiers,
      { group: '盟约增伤（维多利亚）', kind: 'increase' as const, value: 0.25 },
      { group: '盟约增伤（谢拉格）', kind: 'increase' as const, value: 0.35 },
    ];
    expect(damage({ attack: 1000, type: 'arts', resistance: 0, modifiers }).perHit).toBeCloseTo(2531.25, 8);
  });
  it('同名狙击镜携带多件时每件各自相乘', () => {
    // 两件进阶：1.5 × 1.5 = 2.25（同区加算会是 2.0）；普通 + 进阶：1.3 × 1.5 = 1.95。
    const base = calc('char_367_swllow', 'skchr_swllow_2', 'b', []);
    const two = calc('char_367_swllow', 'skchr_swllow_2', 'b', [['精准狙击镜', 'b'], ['精准狙击镜', 'b']]);
    expect(two.normal.dps).toBeCloseTo(base.normal.dps * 2.25, 8);
    expect(two.skill!.dps).toBeCloseTo(base.skill!.dps * 2.25, 8);
    const mixed = calc('char_367_swllow', 'skchr_swllow_2', 'b', [['精准狙击镜', 'a'], ['精准狙击镜', 'b']]);
    expect(mixed.normal.dps).toBeCloseTo(base.normal.dps * 1.95, 8);
  });
});

describe('卡西米尔竞技旗', () => {
  it('前 15 秒 ×1.6，之后每 0.5 秒 −0.07 衰减到 ×1', () => {
    const b = apply('卡西米尔竞技旗', 'b').timedDamageScale;
    // 1.6 − 0.07k > 1 ⇔ k ≤ 8：[15,15.5)=1.53 … [18.5,19)=1.04，第 19 秒回到 1。
    expect(b).toHaveLength(9);
    expect(b[0]).toMatchObject({ from: 0, until: 15, scale: 1.6 });
    expect(b[1]!.scale).toBeCloseTo(1.53, 10);
    expect(b.at(-1)).toMatchObject({ from: 18.5, until: 19 });
    expect(b.at(-1)!.scale).toBeCloseTo(1.04, 10);
    // 普通阶 1.35 − 0.04k > 1 ⇔ k ≤ 8：最后一档 1.03。
    expect(apply('卡西米尔竞技旗').timedDamageScale.at(-1)!.scale).toBeCloseTo(1.03, 10);
  });
  it('倍率按时间过程放大累计伤害', () => {
    // 恒定 100 DPS：额外伤害 = 100 × (15×0.6 + 0.5×Σ_{k=1..8}(0.6−0.07k)) = 100 × (9 + 0.5×2.28) = 1014。
    const at = scaledCurve(t => 100 * t, apply('卡西米尔竞技旗', 'b').timedDamageScale);
    expect(at(180)).toBeCloseTo(18000 + 1014, 8);
    expect(at(10)).toBeCloseTo(1600, 8);
  });
  it('慕斯：竞技旗在前19秒按实际连击状态与每档倍率积分', () => {
    const base = mousse([]);
    const flag = mousse([['卡西米尔竞技旗', 'b']]);
    // 双击按固定序列逐次取值；前19秒攻击节拍与前50秒的平均值不同。
    expect(flag.normal.components.map(c => c.dps)).toEqual(base.normal.components.map(c => c.dps));
    const oneHit = 626.6086956521739 * .75, interval = 38 / 30;
    let bonus = 0;
    for (let k = 0; k * interval < 19; k++) {
      const hits = 1 + Number(swiftSucceeds(k, .2, 1));
      for (let step = 0; step <= 8; step++) {
        const start = step ? 15 + (step - 1) * .5 : 0;
        const end = step ? start + .5 : 15;
        const overlap = Math.max(0, Math.min(end, (k + 1) * interval) - Math.max(start, k * interval));
        bonus += overlap * oneHit * hits / interval * (.6 - .07 * step);
      }
    }
    expect(flag.totalDamage.value - base.totalDamage.value).toBeCloseTo(bonus, 6);
    expect(flag.normal.dps - base.normal.dps).toBeCloseTo(bonus / 50, 6);
    expect(flag.cycle!.avgDps).toBeCloseTo(flag.totalDamage.value / 180, 8);
    expect(flag.assumptions!.join('')).toContain('逐渐衰减');
  });
});

describe('炎国短刀', () => {
  const knife = 'equip:' + equip('炎国短刀', 'b').chessId;
  const layers = (phase: PhaseResult) => phase.stats.derivation.atk.filter(s => s.source === knife && s.value !== 0).map(s => s.value);
  // 0 层时时间过程仍会带一条数值为 0 的叠层修饰，按层数非零过滤。
  it('通用模型：非技能期 0 层，第一次开技能时 1 层', () => {
    const r = mousse([['炎国短刀', 'b']]);
    expect(layers(r.normal)).toEqual([]);
    expect(layers(r.skill!)).toEqual([0.08]);
  });
  it('专属模型（史尔特尔）同样按每次开技能叠一层', () => {
    const base = calc('char_350_surtr', 'skchr_surtr_2', 'b', []);
    const r = calc('char_350_surtr', 'skchr_surtr_2', 'b', [['炎国短刀', 'b']]);
    expect(r.model).toBe('override');
    expect(layers(r.normal)).toEqual([]);
    expect(layers(r.skill!)).toEqual([0.08]);
    expect(r.totalDamage.value).toBeGreaterThan(base.totalDamage.value);
  });
  it('十层封顶', () => {
    expect(apply('炎国短刀').stacks[0]).toMatchObject({ trigger: 'skill', max: 10 });
  });
});

describe('维式重锤', () => {
  it('终极维式重锤：默认 5 种带特殊效果的重锤在场，继承加速、电流、灼燃', () => {
    const e = apply('终极维式重锤', 'a', { boss: boss('boss_1') });
    // atk_per_hammer 0.2 × 5 = +100%；加速重锤 +30 攻速；电流 30% 双穿透；灼燃比例 0.1。
    expect(e.stats.find(s => s.stat === 'atk')!.value).toBeCloseTo(1, 10);
    expect(e.stats.find(s => s.stat === 'attackSpeed')!.value).toBe(30);
    expect(e.defPenetrationPct).toBeCloseTo(0.3, 10);
    expect(e.resPenetrationPct).toBeCloseTo(0.3, 10);
    expect(e.burning?.ratio).toBeCloseTo(0.1, 10);
    expect(e.assumptions.join('')).toContain('5 种');
  });
  it('电流维式重锤：Boss 不免疫麻痹时计 30% 双穿透，免疫时不计', () => {
    expect(apply('电流维式重锤', 'a', { boss: boss('boss_1') }).resPenetrationPct).toBeCloseTo(0.3, 10);
    const immune = apply('电流维式重锤', 'a', { boss: boss('boss_2') });
    expect(immune.resPenetrationPct).toBe(0);
    expect(immune.assumptions.join('')).toContain('免疫麻痹');
    // 慕斯法术、boss_1 法抗 25：有效法抗 25×0.7=17.5，伤害比 (1−0.175)/(1−0.25)=1.1。
    // 对照组双模机械臂普通阶同为攻击力 +30%、面板不含其他效果。
    expect(mousse([['电流维式重锤']], 'boss_1', 'a').normal.dps).toBeCloseTo(mousse([['双模机械臂']], 'boss_1', 'a').normal.dps * 1.1, 8);
    expect(mousse([['电流维式重锤']], 'boss_2', 'a').normal.dps).toBeCloseTo(mousse([['双模机械臂']], 'boss_2', 'a').normal.dps, 8);
  });
  it('灼燃条：按累计伤害求爆条时刻，锁条 10 秒内不积累', () => {
    // 恒定 1000 DPS，比例 0.1 → 每秒 100 灼燃损伤，阈值 2000：20 秒爆条，锁到 30 秒，
    // 之后 50、80、110、140、170 秒爆条，180 秒内 6 次。
    // 额外伤害 = 6×7000 + 减抗增益 0.25 × 1000 × 10 × 6 = 42000 + 15000。
    const curve = burningCurve(t => 1000 * t, { rate: 0.1, threshold: 2000, lock: 10, burst: 7000, windowGain: 0.25, horizon: 180 });
    expect(curve.bursts().map(t => +t.toFixed(9))).toEqual([20, 50, 80, 110, 140, 170]);
    expect(curve.at(180)).toBeCloseTo(180000 + 57000, 6);
    // 19 秒尚未爆条；25 秒已爆一次、窗口内 5 秒。
    expect(curve.at(19)).toBeCloseTo(19000, 6);
    expect(curve.at(25)).toBeCloseTo(25000 + 7000 + 0.25 * 5000, 6);
    // 窗口之后按平均速率延续：每 30 秒一次 7000 + 2500。
    expect(curve.at(240) - curve.at(180)).toBeCloseTo(60000 + 2 * 9500, 6);
  });
  it('法术占比按循环时长加权', () => {
    // 普攻 100 法术、技能 300 物理；循环 10 秒回复 + 5 秒技能：1000 / (1000 + 1500) = 0.4。
    const phase = (dps: number, type: 'arts' | 'physical') => ({ dps, stats: {} as PhaseResult['stats'], components: [
      { label: '', source: 'attack', damageType: type, perHit: dps, hitsPerAttack: 1, hitsPerSec: 1, dps, countsTowardDps: true, derivation: [] }] });
    expect(artsShare({ normal: phase(100, 'arts'), skill: phase(300, 'physical') }, { spRecoverSec: 10, skillDurationSec: 5, avgDps: 0 })).toBeCloseTo(0.4, 10);
  });
  it('灼燃维式重锤只加总伤不改面板；自带灼燃条的专属模型不重复计', () => {
    const arm = indigo([['双模机械臂']]);
    const hammer = indigo([['灼燃维式重锤']]);
    expect(hammer.normal.dps).toBeCloseTo(arm.normal.dps, 8);
    // 深靛普通阶法术 DPS 约 290–410：每秒积累约 30 损伤，180 秒内至少爆条 2 次。
    expect(hammer.totalDamage.value - arm.totalDamage.value).toBeGreaterThan(2 * 7000);
    const blaze = calc('char_1040_blaze2', 'skchr_blaze2_3', 'b', [['灼燃维式重锤', 'b']]);
    // 烛煌S3无原生损伤积累，装锤后按技能实际法伤的10%积入已有元素条。
    const skill = blaze.skill!;
    expect(blaze.elemental?.perSec).toBeCloseTo(skill.stats.atk * .75 / skill.stats.attackInterval * .1, 7);
    expect(blaze.assumptions!.join('')).toContain('共用同一条元素条和爆发冷却');
  });
});

describe('条件增伤', () => {
  it('瓶装烈性反应：默认敌人处于元素爆发，伤害 ×1.5', () => {
    const base = indigo([], 'boss_1', 'b');
    const r = indigo([['瓶装烈性反应', 'b']], 'boss_1', 'b');
    expect(r.normal.dps).toBeCloseTo(base.normal.dps * 1.5, 8);
    expect(r.assumptions!.join('')).toContain('元素爆发');
  });
  it('驱逐者警棍/防暴装备：Boss 免疫晕眩、冻结、恐惧时不计，否则 ×1.3', () => {
    // boss_1 三种全免疫；boss_6 不免疫晕眩、冻结。
    expect(indigo([['驱逐者警棍']]).normal.dps).toBeCloseTo(indigo([]).normal.dps, 8);
    expect(indigo([['驱逐者警棍']]).assumptions!.join('')).toContain('免疫');
    for (const name of ['驱逐者警棍', '驱逐者防暴装备']) {
      const r = indigo([[name]], 'boss_6');
      expect(r.normal.dps).toBeCloseTo(indigo([], 'boss_6').normal.dps * 1.3, 8);
      expect(r.assumptions!.join('')).toContain('晕眩、冻结');
    }
  });
});

describe('动能弩', () => {
  it('概率攻击力在防御前结算，按成功占比加权', () => {
    // 物理 1000 攻、防 500：未触发 500，触发 1300−500=800；0.7×500 + 0.3×800 = 590。
    const proc = { probability: 0.3, scale: 1.3, source: 'test' };
    expect(damage({ attack: 1000, type: 'physical', defense: 500, proc }).perHit).toBeCloseTo(590, 8);
    // 法术线性：0.7×1000 + 0.3×1300 = 1090。
    expect(damage({ attack: 1000, type: 'arts', resistance: 0, proc }).perHit).toBeCloseTo(1090, 8);
    // 慕斯法术、法抗 25：面板 DPS ×1.09。
    expect(mousse([['动能单手弩']]).normal.dps).toBeCloseTo(mousse([]).normal.dps * 1.09, 8);
  });
  it('满层追加伤害受冷却限制', () => {
    // 间隔 1 秒 ≥ 冷却 0.5：每次攻击 0.3 次；间隔 0.3 秒：成功后下一次攻击被挡，1/(1 + 1/0.3) = 0.3/1.3。
    expect(splashPerAttack(1, 0.3, 0.5)).toBeCloseTo(0.3, 10);
    expect(splashPerAttack(0.3, 0.3, 0.5)).toBeCloseTo(0.3 / 1.3, 10);
    expect(splashPerAttack(0.5, 0.3, 0.5)).toBeCloseTo(0.3, 10);
  });
  it('动能轰击弩攻速叠满 60 层后才追加单目标物理伤害', () => {
    // 蓝毒去掉天赋特性，ATK100、间隔1秒、零防抗。满层攻速 +120：间隔 100/220×30=13.6→14 帧 = 0.4667 秒，
    // 冷却 0.5 秒挡住成功后的下一次攻击：每次攻击 0.3/1.3 次，追加 DPS = 100 × (0.3/1.3) / (14/30)。
    const operator = (operatorsJson as unknown as OperatorData[]).find(o => o.name === '蓝毒')!;
    const tier = { ...operator.tiers.b, trait: null, talents: [], garrisonIds: [],
      attributes: { ...operator.tiers.b.attributes, atk: 100, attackSpeed: 100, baseAttackTime: 1 } };
    const target: BossData = { ...bosses[0]!, attributes: { ...bosses[0]!.attributes!, def: 0, magicResistance: 0 } };
    const level: SkillLevelData = { description: '', spType: 'INCREASE_WITH_TIME', spTypeRaw: 1, spCost: 99, initSp: 0, increment: 0,
      duration: 1, maxChargeTime: 1, rangeId: null, prefabId: null, blackboard: { nums: {} } };
    const skill: SkillData = { skillId: 'test', name: '测试', skillType: 'MANUAL', durationType: 'NONE', iconId: null, levels: {} };
    const e = apply('动能轰击弩');
    const model = generic(operator, tier, skill, level, target, e);
    const splash = (phase: PhaseResult) => phase.components.find(c => c.label === '满层追加物理伤害');
    expect(splash(model.normal)).toBeUndefined();
    const full = model.rebuild!([{ ...e.stacks[0]!.modifier, value: 120 }], 60, 60);
    expect(full.normal.stats.attackInterval).toBeCloseTo(14 / 30, 10);
    expect(splash(full.normal)!.dps).toBeCloseTo(100 * (0.3 / 1.3) / (14 / 30), 8);
    expect(splash(model.rebuild!([{ ...e.stacks[0]!.modifier, value: 118 }], 59, 59).normal)).toBeUndefined();
  });
});

describe('其他装备', () => {
  it('迅捷作战粮：同盟约其他干员按所属盟约在场人数 − 1 的最大值计', () => {
    const bonds = [{ bondId: 'victoriaShip', stacks: 0, activeChars: 4 }, { bondId: 'swiftShip', stacks: 0, activeChars: 2 }];
    // 进阶 6 点：部署 6 + 6 × max(4−1, 2−1) = 24。
    expect(apply('迅捷作战粮', 'b', { bonds, memberBondIds: ['victoriaShip', 'swiftShip'] }).initSp).toBe(24);
    // 不属于的盟约不计：只属于迅捷时 6 + 6×1 = 12。
    expect(apply('迅捷作战粮', 'b', { bonds, memberBondIds: ['swiftShip'] }).initSp).toBe(12);
  });
  it('天马之枪 + 天马之盔组合为天马之耀；动能加速器 + 单手弩组合为轰击弩', () => {
    expect(combineEquips([equip('天马之枪'), equip('天马之盔')]).equips.map(e => e.name)).toEqual(['天马之耀']);
    expect(combineEquips([equip('伊比利亚骨刺刀'), equip('动能单手弩'), equip('动能加速器')]).equips.map(e => e.name)).toEqual(['伊比利亚骨刺刀', '动能轰击弩']);
    const pair = calc('char_350_surtr', 'skchr_surtr_2', 'b', [['天马之枪'], ['天马之盔']]);
    const glory = calc('char_350_surtr', 'skchr_surtr_2', 'b', [['天马之耀']]);
    expect(pair.totalDamage.value).toBeCloseTo(glory.totalDamage.value, 6);
    expect(pair.normal.dps).toBeCloseTo(glory.normal.dps, 8);
    expect(pair.assumptions!.join('')).toContain('组合为天马之耀');
  });
  it('乌萨斯呼吸器只有 1 层：进阶攻击力 +30%', () => {
    // 慕斯精锐阶面板没有其他百分比加攻，普攻 DPS ×1.3。
    expect(mousse([['乌萨斯呼吸器', 'b']]).normal.dps).toBeCloseTo(mousse([]).normal.dps * 1.3, 8);
  });
  it('双模机械臂：攻击力 +30%，并把自身物理和法术伤害转为弱点伤害', () => {
    const e = apply('双模机械臂');
    expect(e.stats).toEqual([expect.objectContaining({ stat: 'atk', value: 0.3 })]);
    expect(e.weakness?.source).toBe(`equip:${equip('双模机械臂').chessId}`);
    expect(e.derivation.some(s => s.label.includes('弱点伤害'))).toBe(true);
    expect(e.notes.join('')).not.toContain('未知');
    expect(equipCoverage(equip('双模机械臂')).status).toBe('已建模');
  });
});

describe('equipCoverage 与 DPS 无关名单', () => {
  it('名单内装备不改变携带者的任何结果', () => {
    const unrelated = equips.filter(e => equipCoverage(e).status === '与 DPS 无关');
    expect(unrelated.length).toBeGreaterThan(30);
    // boss_6 不免疫晕眩、冻结，控制类装备若误计会显出来。
    const base = mousse([], 'boss_6', 'b');
    for (const item of unrelated) {
      const r = calculate({ ...base.input, equips: [item.chessId] });
      expect(r.totalDamage.value, item.name).toBeCloseTo(base.totalDamage.value, 8);
      expect(r.normal.dps, item.name).toBeCloseTo(base.normal.dps, 8);
    }
  });
  it('组合后改变输出的部件不在名单内', () => {
    for (const name of ['天马之盔', '汲取者之喙', '动能单手弩', '驱逐者警棍', '精准狙击镜', '卡西米尔竞技旗', '瓶装烈性反应', '终极维式重锤'])
      expect(equipCoverage(equip(name)).status, name).not.toBe('与 DPS 无关');
  });
});
