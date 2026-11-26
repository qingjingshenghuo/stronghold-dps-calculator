import { describe, expect, it } from 'vitest';
import bondsJson from '../data/generated/bonds.json';
import operatorsJson from '../data/generated/operators.json';
import { calculate } from './calc.ts';
import { applyBonds } from './effects/bonds.ts';
import { battleEffects } from './effects/common.ts';
import { swiftDraw, swiftSucceeds } from './swift.ts';
import type { BondData, BondSetting, OperatorData } from './types.ts';

const operators = operatorsJson as unknown as OperatorData[];
const bonds = bondsJson as BondData[];
const base = { tier: 'b' as const, equips: [] as string[], bossId: 'boss_1', modeId: 'mode_single_10', cultivation: 2060, potential: 5 };
const run = (charId: string, skillId: string, list: BondSetting[], durationSec = 180) =>
  calculate({ ...base, charId, skillId, bonds: list, durationSec });
const bond = (bondId: string, activeChars: number, stacks: number): BondSetting => ({ bondId, activeChars, stacks });

describe('180 秒窗口', () => {
  it('缺省窗口 180 秒，循环平均 = 窗口总伤 ÷ 180', () => {
    const r = calculate({ ...base, charId: 'char_350_surtr', skillId: 'skchr_surtr_2', bonds: [] });
    expect(r.totalDamage.durationSec).toBe(180);
    expect(r.cycle!.avgDps).toBeCloseTo(r.totalDamage.value / 180, 9);
  });
});

describe('迅捷回技的概率与开技次数', () => {
  it('同一序列下概率越高成功越多，概率 1 恒成功', () => {
    // u_k 只与 k 有关：p1 < p2 时 {u_k < p1} ⊆ {u_k < p2}。
    for (let k = 0; k < 200; k++) {
      expect(swiftDraw(k)).toBeGreaterThanOrEqual(0);
      expect(swiftDraw(k)).toBeLessThan(1);
      if (swiftSucceeds(k, 0.3)) expect(swiftSucceeds(k, 0.6)).toBe(true);
      expect(swiftSucceeds(k, 1)).toBe(true);
      expect(swiftSucceeds(k, 0)).toBe(false);
    }
  });
  it('陨星高爆弹头 0 / 228 / 229 / 999 层结果连续，无零时长无限连发', () => {
    // 概率 = 0.2 + 0.0035×层数：228 层 0.998，229 层起封顶 1。40层后两项回技合计27，高于23点消耗；
    // 零时长技能两次施放至少间隔一个攻击间隔，因此 228 与 229 层只差约 0.2% 的失败判定。
    const at = (stacks: number) => run('char_219_meteo', 'skchr_meteo_2', [bond('swiftShip', 2, stacks)]);
    const [r0, r228, r229, r999] = [0, 228, 229, 999].map(at);
    for (const r of [r0, r228, r229, r999]) expect(Number.isFinite(r.totalDamage.value)).toBe(true);
    expect(r228.totalDamage.value).toBeGreaterThan(r0.totalDamage.value);
    expect(Math.abs(r229.totalDamage.value - r228.totalDamage.value) / r228.totalDamage.value).toBeLessThan(0.01);
    expect(r999.totalDamage.value).toBeCloseTo(r229.totalDamage.value, 6);
    // 第23秒首发，之后即使满额回技也要等2.8秒。使用破片杀伤成功时的上界，开场快照可能没有暴击。
    const panel = (829.4683544303798 + 35) * 1.1;
    const reducedDef = 1000 - 100 - 210;
    const critShot = panel * 1.6 * 2.4 - reducedDef, critNormal = panel * 1.6 - reducedDef;
    const count = 1 + Math.floor((180 - 23) / 2.8);
    expect(r229.totalDamage.value).toBeLessThanOrEqual(count * critShot + 180 / 2.8 * critNormal);
    const nearCast = (seconds: number) => run('char_219_meteo', 'skchr_meteo_2', [bond('swiftShip', 2, 229)], seconds).totalDamage.value;
    expect(nearCast(25.799) - nearCast(23)).toBeLessThanOrEqual(critNormal + 1e-6);
    expect(nearCast(25.8) - nearCast(25.799)).toBeGreaterThanOrEqual(panel * 2.4 - reducedDef);
    // 同一配置重复计算结果固定。
    expect(at(150).totalDamage.value).toBe(at(150).totalDamage.value);
  });
  it.each([[40, .34, 10], [45, .3575, 11]])('陨星高爆弹头%d层，以180秒内的开技次数选择短窗计算口径', (stacks, p, expectedCasts) => {
    // 满潜精锐，23技力、2.8秒间隔。进阶作战粮初始+6，另一名迅捷成员再给6，故首发11秒。
    // 在代表轴上，成功回27封顶到23，等待2.8秒；失败需要23秒。按该轴区分10/11次。
    let casts = 0;
    for (let t = 11; t <= 180; casts++) {
      const draw = (.5 + casts * (Math.sqrt(5) - 1) / 2) % 1;
      t += draw < p ? 2.8 : 23;
    }
    expect(casts).toBe(expectedCasts);
    const at = (durationSec: number) => calculate({ ...base, charId: 'char_219_meteo', skillId: 'skchr_meteo_2',
      equips: ['chess_item_3_04_e_b'], bonds: [bond('swiftShip', 2, stacks)], durationSec });
    // 13.8秒的第二次施放仅在首发结束成功回技时出现。天赋与普攻共用动作序号，此发是第6个动作，触发破片杀伤。
    const panel = (829.4683544303798 + 35) * 1.1;
    const burst = panel * 1.6 * 2.4 - (1000 - 100 - 210);
    const now = at(13.8), before = at(13.799);
    expect(now.totalDamage.value - before.totalDamage.value).toBeCloseTo(expectedCasts === 10 ? p * burst : 0, 6);
    expect(now.cycle!.avgDps).toBeCloseTo(now.totalDamage.value / 13.8, 7);
  });
  it.each([
    ['a', false, 14075.669092277649], ['a', true, 13861.92909618711],
    ['b', false, 40174.01151212904], ['b', true, 41970.19537773555],
  ] as const)('陨星%s阶迅捷40层、进阶作战粮=%s，较早回技的分支继续计算第11发及以后', (tier, meal, expected) => {
    // 独立以0.1秒为刻度倒推。普攻击中刻为28j，失败后等待240/230刻，成功后28刻。
    // 第n发的序号为此前普攻数+n−1。当次技能先减170/210防，100刻内的普攻沿用减防；
    // 每个节点将两个后继窗口总伤分别乘0.34/0.66。精锐加粮若只展开前10抽会误算成41575.251502。
    const result = calculate({ ...base, tier, charId: 'char_219_meteo', skillId: 'skchr_meteo_2',
      equips: meal ? ['chess_item_3_04_e_b'] : [], bonds: [bond('swiftShip', 2, 40)] });
    expect(result.totalDamage.value).toBeCloseTo(expected, 7);
    expect(result.cycle!.avgDps).toBeCloseTo(expected / 180, 7);
  });
});

describe('面板快照与时间过程同一口径', () => {
  it('荒芜拉普兰德 S2 叙拉古 3 人 400 层：技能期不低于非技能期', () => {
    // 两期都在第一次开技时刻取值：部署攻速 32+0.4×400=192 秒，开技时仍生效；技能期再加攻击力、天赋攻速与新增浮游单元。
    const r = run('char_1038_whitw2', 'skchr_whitw2_2', [bond('siracusaShip', 3, 400)]);
    expect(r.skill!.dps).toBeGreaterThanOrEqual(r.normal.dps);
    // 开技前一刻部署攻速仍在：非技能期面板攻速含叙拉古 +25+0.8×400=+345。
    expect(r.normal.stats.derivation.attackSpeed.some(s => s.source === 'bond:siracusaShip' && s.value === 345)).toBe(true);
  });
});

describe('逐盟约', () => {
  it('深靛吃伊比利亚 3 人 0 层：持续法伤按叠满 10 层', () => {
    // 每层每秒 攻击力×(0.11+0.0006×0)，叠满 10 层 → 每秒 1.1×攻击力 的法术伤害；boss_1 法抗 25 → ×0.75。
    const r = run('char_469_indigo', 'skchr_indigo_1', [bond('iberiaShip', 3, 0)]);
    const dot = r.normal.components.find(c => c.source === 'bond:iberiaShip:dot')!;
    expect(dot.hitsPerSec).toBe(1);
    expect(dot.perHit).toBeCloseTo(r.normal.stats.atk * 1.1 * 0.75, 6);
    expect(r.assumptions).toContain('【伊比利亚】持续法术伤害直接按叠满计算');
    // 6 人：持续法伤 ×2，弹射忽略。
    const six = run('char_469_indigo', 'skchr_indigo_1', [bond('iberiaShip', 6, 0)]);
    expect(six.normal.components.find(c => c.source === 'bond:iberiaShip:dot')!.perHit).toBeCloseTo(2 * dot.perHit, 6);
    expect(six.assumptions).toContain('【伊比利亚】弹射忽略');
    expect(six.notes.some(n => n.startsWith('近似：') && n.includes('弹射忽略'))).toBe(true);
  });

  it('灵知吃谢拉格 3 人 100 层：默认敌人寒冷，增伤 1.35+0.01×100=2.35', () => {
    const none = run('char_206_gnosis', 'skchr_gnosis_1', []);
    const r = run('char_206_gnosis', 'skchr_gnosis_1', [bond('kjeragShip', 3, 100)]);
    // 无其他增伤乘区：非技能期 DPS 正好放大 2.35 倍（替代基础 1.25，不叠乘）。
    expect(r.normal.dps / none.normal.dps).toBeCloseTo(2.35, 9);
    expect(r.assumptions).toContain('【谢拉格】默认敌人始终处于寒冷或冻结');
    expect(r.normal.components[0]!.derivation.some(s => s.label.includes('默认敌人始终处于寒冷或冻结'))).toBe(true);
  });

  it('灵知携带维式重锤和变形同构体，普攻同时获得维多利亚与谢拉格的乘算增伤', () => {
    const config = { ...base, charId: 'char_206_gnosis', skillId: 'skchr_gnosis_1',
      equips: ['chess_item_1_01_e_a', 'chess_item_6_03_e_a'] };
    const normal = (...bonds: BondSetting[]) => calculate({ ...config, bonds }).normal;
    const victoria = bond('victoriaShip', 3, 0);
    const kjerag = bond('kjeragShip', 3, 0);
    const baseline = normal().dps;
    expect(baseline).toBeGreaterThan(0);
    expect(normal(victoria).dps / baseline).toBeCloseTo(1.25, 9);
    expect(normal(kjerag).dps / baseline).toBeCloseTo(1.35, 9);
    const both = normal(victoria, kjerag);
    expect(both.dps / baseline).toBeCloseTo(1.25 * 1.35, 9);
    expect(both.components[0]!.derivation).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '盟约增伤（维多利亚）', op: 'mul', value: 1.25 }),
      expect.objectContaining({ label: '盟约增伤（谢拉格）', op: 'mul', value: 1.35 }),
    ]));
  });

  it('贝洛内吃叙拉古 6 人：默认敌人有 2 种以上异常状态，每秒 800 真伤计入本成员', () => {
    // 0 层每秒 800+10×0 = 800 真实伤害，从部署起第 1 秒开始结算：180 秒共 180 次 = 144000。
    const three = run('char_4037_demetr', 'skchr_demetr_1', [bond('siracusaShip', 3, 0)]);
    const six = run('char_4037_demetr', 'skchr_demetr_1', [bond('siracusaShip', 6, 0)]);
    expect(six.totalDamage.value - three.totalDamage.value).toBeCloseTo(144000, 6);
    // 首次开技前有四个17帧普攻间隔。2.267秒只有两跳，非技能期均值来自实际累计曲线。
    const firstCast = 4 * 17 / 30;
    expect(six.normal.dps - three.normal.dps).toBeCloseTo(2 * 800 / firstCast, 6);
    expect(six.normal.components.find(c => c.source === 'bond:siracusaShip:abnormal')?.dps).toBe(800);
    expect(six.assumptions).toContain('【叙拉古】默认敌人始终处于 2 种以上异常状态');
    // 裁度策略替换默认 6 人效果，不再计异常真伤。
    const band = run('char_4037_demetr', 'skchr_demetr_1', [{ ...bond('siracusaShip', 6, 0), bandId: 'band_siracusa' }]);
    expect(band.normal.components.some(c => c.source === 'bond:siracusaShip:abnormal')).toBe(false);
  });

  it('玛恩纳卡西米尔 6 人：开技后 30 秒窗口覆盖整段技能，非技能期不攻击', () => {
    // S3 进阶：初始 20、消耗 45、每秒 1 → 第 25 秒开技，持续 26 秒（< 30 秒窗口）。
    // 0~25 秒玛恩纳不攻击，6 人与 3 人总伤相同；25~51 秒真伤分项秒伤恒定，差值 = 真伤秒伤 × 26。
    const at = (n: number, d: number) => run('char_4064_mlynar', 'skchr_mlynar_3', [bond('kazimierzShip', n, 0)], d);
    expect(at(6, 25).totalDamage.value - at(3, 25).totalDamage.value).toBeCloseTo(0, 6);
    const kaz = at(6, 180).skill!.components.find(c => c.source === 'bond:kazimierzShip')!;
    // 真伤 = 攻击力 × 0.65，每次本体攻击一次。
    expect(kaz.perHit).toBeCloseTo(at(6, 180).skill!.stats.atk * 0.65, 6);
    expect(at(6, 51).totalDamage.value - at(3, 51).totalDamage.value).toBeCloseTo(kaz.dps * 26, 4);
  });

  it('野鬃卡西米尔 6 人：部署后与开技后各 30 秒窗口，窗口外不附带真伤', () => {
    // S2：初始 25、消耗 40 → 第 15 秒开技、持续 20 秒；回复 40 秒 → 第 75 秒再开。
    // 窗口 [0,30) ∪ [15,45)；[45,75) 无真伤，6 人与 3 人的总伤差在此区间不变。
    const diff = (d: number) => run('char_496_wildmn', 'skchr_wildmn_2', [bond('kazimierzShip', 6, 0)], d).totalDamage.value
      - run('char_496_wildmn', 'skchr_wildmn_2', [bond('kazimierzShip', 3, 0)], d).totalDamage.value;
    expect(diff(74) - diff(46)).toBeCloseTo(0, 6);
    // [35,45) 是技能结束后、开技窗口内的普攻：差值 = 非技能期真伤秒伤 × 10。
    const normal = run('char_496_wildmn', 'skchr_wildmn_2', [bond('kazimierzShip', 6, 0)]).normal.components.find(c => c.source === 'bond:kazimierzShip')!;
    expect(diff(45) - diff(35)).toBeCloseTo(normal.dps * 10, 4);
  });

  it('坚守 3 人只计脆弱，反伤忽略；乌萨斯、莱塔尼亚只计攻击力并注明忽略项', () => {
    const named = (name: string) => operators.find(o => o.name === name)!;
    const calc = (name: string, list: BondSetting[]) => { const o = named(name); return run(o.charId, o.skillIds[o.defaultSkillIndex]!, list); };
    // 坚守强化：脆弱 ×1.4 常驻，非技能期 DPS 正好 ×1.4（摆渡人无其他脆弱来源）。
    const stead = calc('摆渡人', [bond('steadShip', 3, 0)]);
    expect(stead.normal.dps / calc('摆渡人', []).normal.dps).toBeCloseTo(1.4, 9);
    expect(stead.assumptions).toContain('【坚守】只计脆弱增伤，反伤忽略');
    expect(stead.normal.components.some(c => /反伤/.test(c.label))).toBe(false);
    expect(calc('烈夏', [bond('ursusShip', 3, 0)]).assumptions).toContain('【乌萨斯】临时层数与阻挡敌人的法术伤害忽略');
    expect(calc('折光', [bond('lethaniaShip', 6, 0)]).assumptions).toContain('【莱塔尼亚】「一个乐部」攻速提升忽略（无法确定场上召唤物数量）');
  });

  it('精准 3 人对可放远程位的温蒂生效：无视 30% 防御', () => {
    // 温蒂 position=ALL，非精准成员；3 人强化后“所有远程干员”含可放远程位的干员。
    const e = battleEffects();
    const o = operators.find(x => x.charId === 'char_400_weedy')!;
    applyBonds(e, bonds, [bond('preciShip', 3, 0)], o, o.tiers.b, []);
    expect(e.defPenetrationPct).toBe(0.3);
    expect(e.resPenetrationPct).toBe(0.3);
    expect(e.stats.some(s => s.stat === 'atk' && s.value === 0.1)).toBe(true);
  });
});

describe('装备叠层按 180 秒真实过程', () => {
  const equipRun = (charId: string, skillId: string, equips: string[]) => calculate({ ...base, charId, skillId, equips, bonds: [] });
  it('专属模型也能叠：史尔特尔 S2 带进阶灵巧涡轮手套', () => {
    // 手套每秒 +3 攻速，至多 20 层（+60）。专属时间轴按触发时刻分段换用叠层后的面板。
    const plain = equipRun('char_350_surtr', 'skchr_surtr_2', []);
    const glove = equipRun('char_350_surtr', 'skchr_surtr_2', ['chess_item_2_10_e_b']);
    expect(glove.totalDamage.value).toBeGreaterThan(plain.totalDamage.value);
    // 非技能期面板取开技前一刻：已叠若干层，但不超过上限 +60。
    expect(glove.normal.stats.attackSpeed).toBeGreaterThan(plain.normal.stats.attackSpeed);
    expect(glove.normal.stats.attackSpeed).toBeLessThanOrEqual(plain.normal.stats.attackSpeed + 60);
    expect(glove.notes.some(n => n.startsWith('近似：专属模型的装备叠层'))).toBe(true);
    expect(glove.notes.some(n => n.includes('尚未逐事件重建'))).toBe(false);
  });
  it('专属模型也能叠：艾雅法拉 S2 带多功能补剂，莱塔尼亚临时层数随伤害增加', () => {
    const bonds = [bond('lethaniaShip', 3, 0)];
    const plain = calculate({ ...base, charId: 'char_180_amgoat', skillId: 'skchr_amgoat_2', equips: [], bonds });
    const tonic = calculate({ ...base, charId: 'char_180_amgoat', skillId: 'skchr_amgoat_2', equips: ['chess_item_3_13_e_b'], bonds });
    expect(tonic.totalDamage.value).toBeGreaterThan(plain.totalDamage.value);
  });
  it('通用模型的技能期面板取第一次开技时的层数：慕斯带动能加速器', () => {
    // 动能加速器每次攻击 +2 攻速、至多 60 层；开技时已有若干层，技能期面板攻速高于 0 层。
    const plain = equipRun('char_185_frncat', 'skchr_frncat_1', []);
    const kinetic = equipRun('char_185_frncat', 'skchr_frncat_1', ['chess_item_6_07_e_a']);
    expect(kinetic.skill!.stats.attackSpeed).toBeGreaterThan(plain.skill!.stats.attackSpeed);
    expect(kinetic.normal.stats.attackSpeed).toBeGreaterThanOrEqual(plain.normal.stats.attackSpeed);
    expect(kinetic.cycle!.avgDps).toBeCloseTo(kinetic.totalDamage.value / 180, 9);
  });
});

