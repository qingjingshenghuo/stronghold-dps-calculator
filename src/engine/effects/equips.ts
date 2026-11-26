import equipsJson from '../../data/generated/equips.json' with { type: 'json' };
import type { BondSetting, BossData, EquipData } from '../types.ts';
import type { StatModifier } from '../stats.ts';
import { battleEffects, record, type BattleEffects, type Coverage } from './common.ts';

const allEquips = equipsJson as EquipData[];

// 按装备描述核对的名单；这些效果只涉及生存、控制或局外经济，不增加携带者的单体输出。
// 天马之盔、汲取者之喙单独携带不加输出，但与天马之枪、汲取者之心组合后改变输出，因此不在名单内。
const unrelated = new Set([
  '坚守盾牌', '奥术法阵', '歌利亚头盔', '蜂鸣器', '伪装服', '不屈弹射器', '护盾无人机',
  '突袭手雷', '盟约之币', 'M3茧甲', '拟态物质', '人事部文档', '博士投影', '寻呼模块', '信标',
  '精打细算玩偶', '见钱眼开玩偶', '简易通讯机', '紧急调度券', '驮兽储蓄罐',
  '随身身份牌', '虹彩活血饮料', '雪祀之衣', '卫戍推荐信', '聚合急救箱', '定期存折',
  '一次性促销券', '投机骰子', '人事部记录', '驱逐者瓦斯', '不退者之盾', '不退者力场',
  '不退者卫护系统',
]);
const unsupported: Record<string, string> = {
  '谢拉格不融冰': '寒冷概率及重复施加导致冻结的覆盖率未建模，未计冻结减抗',
  '莱塔尼亚小鼓': '缺少范围内单位被击倒的频率，未计击倒回复技力',
};
// 这些装备描述中的“攻击力+X%”对应 attr_common_global_buff.atk；无条件而非触发效果。
const baseAttack = new Set([
  '维式重锤', '灼燃维式重锤', '坚固维式重锤', '加速维式重锤', '战栗维式重锤',
  '阿戈尔重刃', '双模机械臂', '天马之枪', '源石溶剂', '电流维式重锤', '天马之耀',
]);
/** 驱逐者装备描述点名的异常状态及 Boss 免疫字段（enemy_database attributes.*Immune）。 */
const controlStates: [string, string][] = [['stunImmune', '晕眩'], ['frozenImmune', '冻结'], ['fearedImmune', '恐惧']];

export interface EquipContext {
  /** 仅在当前计算场景明确给出站位时设置。 */
  targetDistance?: number;
  /** 目标 Boss：异常状态类条件按其免疫判定；缺省时（覆盖统计）按条件满足。 */
  boss?: Pick<BossData, 'attributes'>;
  /** 盟约输入与携带者所属盟约，用于“同盟约的其他干员”计数。 */
  bonds?: BondSetting[];
  memberBondIds?: string[];
  hasActiveMemberBond?: boolean;
  /** 终极维式重锤：场上带特殊效果的维式重锤（装备名）；缺省按 5 种都在场。 */
  fieldHammers?: string[];
}

/**
 * 装备增伤按每件装备各自分区，与盟约增伤（维多利亚/谢拉格）及其他装备增伤相乘；
 * 同名装备携带多件时每件也各自成区，如两件进阶精准狙击镜为 1.5 × 1.5 = 2.25。来源：模型假设。
 */
const equipDamageGroup = (name: string, copy: number) => `装备增伤：${name}${copy > 1 ? ` #${copy}` : ''}`;

/** 满层后追加伤害的每次攻击期望次数：成功后 cooldown 内的攻击不能再触发。 */
export function splashPerAttack(interval: number, probability: number, cooldown: number) {
  if (!(probability > 0) || !(interval > 0)) return 0;
  // 成功后被冷却挡住的攻击数：间隔 I 时，cooldown 内还有 ceil(cooldown/I)-1 次攻击。
  const blocked = Math.max(0, Math.ceil(cooldown / interval - 1e-9) - 1);
  return 1 / (blocked + 1 / Math.min(1, probability));
}
/** 该来源的攻速叠层是否已满（叠层修饰来自装备叠层或分段重建的静态面板）。 */
export function splashReady(e: Pick<BattleEffects, 'splash'>, modifiers: StatModifier[]) {
  const splash = e.splash;
  if (!splash) return false;
  const total = modifiers.filter(m => m.source === splash.source && m.stat === 'attackSpeed').reduce((n, m) => n + m.value, 0);
  return total >= splash.fullAt - 1e-9;
}

/**
 * 同时携带两件可组合装备时按游戏规则替换为组合装备（描述“若与“X”同时持有则组合为“Y””）。
 * 组合装备占用前一件的位置。
 */
export function combineEquips(list: EquipData[]): { equips: EquipData[]; combined: { from: [string, string]; to: EquipData }[] } {
  const equips = [...list];
  const combined: { from: [string, string]; to: EquipData }[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const [slot, item] of equips.entries()) {
      const match = item.desc.replace(/<[^>]*>/g, '').match(/若与“(.+?)”同时持有则组合为“(.+?)”/);
      if (!match) continue;
      const partnerSlot = equips.findIndex((x, index) => index !== slot && x.name === match[1]);
      const result = allEquips.find(x => x.name === match[2]);
      if (partnerSlot < 0 || !result) continue;
      const partner = equips[partnerSlot]!;
      // 同名副本共享数据对象；合成只消耗选中的两个槽位。
      equips[Math.min(slot, partnerSlot)] = result;
      equips.splice(Math.max(slot, partnerSlot), 1);
      combined.push({ from: [item.name, partner.name], to: result });
      changed = true;
      break;
    }
  }
  return { equips, combined };
}

export function applyEquips(e: BattleEffects, equips: EquipData[], activeBondCount: number, context: EquipContext = {}): void {
  const copies = new Map<string, number>();
  for (const equip of equips) {
    const source = `equip:${equip.chessId}`;
    const copy = (copies.get(equip.name) ?? 0) + 1;
    copies.set(equip.name, copy);
    const buff = (key: string) => equip.buffs.find(b => b.blackboard.strs?.key === key)?.blackboard;
    const nums = (key: string) => buff(key)?.nums ?? {};
    const add = (stat: StatModifier['stat'], bucket: StatModifier['bucket'], value: number, skill = false) => {
      (skill ? e.skillStats : e.stats).push({ stat, bucket, value, source });
      record(e, source, `${equip.name} ${skill ? '技能期间 ' : ''}${stat}:${bucket}`, value);
    };
    const note = (reason: string) => e.notes.push(`${equip.name}：${reason}`);
    /** 模型假设：写进计算过程与 notes（近似：），并给界面一条短说明。 */
    const assume = (label: string, value: number, display: string) => {
      record(e, source, label, value);
      e.notes.push(label.startsWith(equip.name) ? `近似：${label}` : `近似：${equip.name}：${label}`);
      e.assumptions.push(`【${equip.name}】${display}`);
    };
    const stack = (trigger: 'skill' | 'attack' | 'second', max: number, stat: StatModifier['stat'], bucket: StatModifier['bucket'], value: number) => {
      e.stacks.push({ trigger, max, modifier: { stat, bucket, value, source } });
      record(e, source, `${equip.name} 每层${stat}（最多${max}层）`, value);
    };
    const increase = (scale: number) => e.modifiers.push({ group: equipDamageGroup(equip.name, copy), kind: 'increase', value: scale - 1, source });
    /** 百分比穿透：多个来源按 1-(1-a)(1-b) 相乘合并（模型假设）。 */
    const penetrate = (def: number, res: number) => {
      e.defPenetrationPct = 1 - (1 - e.defPenetrationPct) * (1 - def);
      e.resPenetrationPct = 1 - (1 - e.resPenetrationPct) * (1 - res);
    };
    const immune = (key: string) => context.boss?.attributes?.immunities?.[key] === true;
    // “对麻痹的敌人造成伤害时无视其30%防御和法术抗性”：异常状态条件跟随 Boss 免疫。
    const palsyPenetration = (n: Record<string, number>, label: string) => {
      if (immune('palsyImmune')) {
        record(e, source, `${label}：Boss 免疫麻痹，对麻痹目标的穿透不计`, 0);
        e.assumptions.push(`【${equip.name}】Boss 免疫麻痹，对麻痹敌人的穿透不计`);
        return;
      }
      penetrate(n.def_penetrate!, n.magic_resist_penetrate!);
      assume(`${label}：默认敌人已通过其它方式处于麻痹，无视 ${n.def_penetrate! * 100}% 防御和 ${n.magic_resist_penetrate! * 100}% 法术抗性（百分比穿透，与其他来源相乘合并）`,
        n.def_penetrate!, `默认敌人已通过其它方式处于麻痹状态，无视 ${n.def_penetrate! * 100}% 防御和法术抗性`);
    };
    // “造成法术伤害时附带相当于10%伤害的灼燃损伤”：damage_scale 是灼燃损伤占法术伤害的比例。
    const burning = (ratio: number) => {
      e.burning = { ratio: (e.burning?.ratio ?? 0) + ratio, source };
      assume(`灼燃损伤：法术伤害的 ${ratio * 100}% 积累灼燃损伤；爆条后造成 7000 元素伤害并使法术抗性 -20 持续 10 秒，期间不积累。爆发和减抗增伤按实际时刻计入伤害曲线`,
        ratio, `法术伤害的 ${ratio * 100}% 积累灼燃损伤，按达到阈值的时刻计入爆发伤害`);
    };
    if (unrelated.has(equip.name)) continue;
    if (unsupported[equip.name]) { note(unsupported[equip.name]); continue; }
    if (baseAttack.has(equip.name)) {
      const n = nums('attr_common_global_buff');
      add('atk', 'pct', n.atk!);
      if (n.attack_speed !== undefined) add('attackSpeed', 'direct', n.attack_speed);
    }
    switch (equip.name) {
      // 配对授予的成员身份由 applyBonds 结算。
      case '变形同构体': break;
      case '维式重锤': case '坚固维式重锤': case '战栗维式重锤': case '阿戈尔重刃': case '源石溶剂': case '天马之枪': break;
      // 单带只加生命；同时携带时由 combineEquips 组合。
      case '天马之盔': case '汲取者之喙': break;
      case '灼燃维式重锤': burning(nums('act1autochess_equip_acarm042_global_buff').damage_scale!); break;
      // “自身造成物理和法术伤害时，伤害类型转化为弱点伤害”：每段按物理、法术各结算一遍取较高者（见 damage.ts）。
      case '双模机械臂':
        e.weakness ??= { source };
        record(e, source, '双模机械臂：自身造成的物理和法术伤害转为弱点伤害（逐段按物理、法术各结算一遍，取较高者）', 1);
        break;
      case '电流维式重锤': palsyPenetration(nums('act3autochess_equip_acarm140_global_buff'), '电流维式重锤'); break;
      case '加速维式重锤':
        add('attackSpeed', 'direct', nums('act1autochess_equip_acarm044_global_buff').attack_speed!); break;
      case '终极维式重锤': {
        // “获得当前场上所有维式重锤特殊效果，且每有一种带有特殊效果的维式重锤自身攻击力额外+20%”。
        // blackboard strs.hammer_1..5 列出带特殊效果的 5 种重锤（普通维式重锤没有特殊效果，不计入种数）。
        // 场上有哪几种由输入 fieldHammers 指定；缺省时按 5 种都在场（模型假设）。
        const board = buff('act1autochess_equip_acarm079_global_buff')!;
        const n = board.nums;
        const kinds = Object.keys(board.strs ?? {}).filter(k => /^hammer_\d+$/.test(k))
          .map(k => allEquips.find(x => x.chessId.startsWith(`${board.strs![k]}_`))?.name ?? board.strs![k]!);
        const field = context.fieldHammers;
        const present = field === undefined ? kinds : kinds.filter(k => field.includes(k));
        const bonus = n.atk_per_hammer! * present.length;
        const listed = present.length ? `${present.join('、')} 共 ${present.length} 种` : '0 种';
        if (bonus > 0) add('atk', 'pct', bonus);
        if (field === undefined) {
          assume(`终极维式重锤：默认场上有 ${listed}带特殊效果的维式重锤，攻击力 +${Math.round(bonus * 100)}%（每种 +${Math.round(n.atk_per_hammer! * 100)}%），并继承各自的特殊效果`,
            present.length, `默认场上有 ${present.length} 种带特殊效果的维式重锤（${present.join('、')}，攻击力 +${Math.round(bonus * 100)}%），继承其特殊效果`);
        } else {
          record(e, source, `终极维式重锤：按场上 ${listed}带特殊效果的维式重锤计算，攻击力 +${Math.round(bonus * 100)}%（每种 +${Math.round(n.atk_per_hammer! * 100)}%），只继承这几种的特殊效果`, present.length);
          e.assumptions.push(present.length
            ? `【终极维式重锤】按场上 ${present.length} 种带特殊效果的维式重锤计算（${present.join('、')}），攻击力 +${Math.round(bonus * 100)}%，只继承这几种的特殊效果`
            : '【终极维式重锤】场上没有带特殊效果的维式重锤，不加攻击力，不继承特殊效果');
        }
        // 继承：加速（攻速）、电流（对麻痹目标穿透）、灼燃（灼燃损伤）；坚固（不死）与战栗（缴械）不影响输出。
        // 继承的数值取终极维式重锤自己的 blackboard（与各重锤原值相同）。
        if (present.includes('加速维式重锤')) add('attackSpeed', 'direct', n.attack_speed!);
        if (present.includes('电流维式重锤')) palsyPenetration(n, '终极维式重锤继承电流维式重锤');
        if (present.includes('灼燃维式重锤')) burning(n.damage_scale!);
        break;
      }
      case '炎国短刀': {
        // “每开启一次技能…最多叠加10次”：atk_buff_cnt 是层数，atk 为每层百分比。
        const n = nums('act1vautochess_equip_acarm024_global_buff');
        stack('skill', n.atk_buff_cnt!, 'atk', 'pct', n.atk!); break;
      }
      case '萨尔贡浓茶': {
        const value = nums('act1autochess_equip_acarm050_global_buff').sp_recovery_per_sec!;
        e.spRecovery += value; record(e, source, '技力自然回复速度加算', value); break;
      }
      case '迅捷作战粮': {
        // “部署时获得N点技力；每有一个同盟约的其他干员，额外获得N点技力”。
        const value = nums('act1autochess_equip_acarm051_global_buff').sp_each_person!;
        e.initSp += value; record(e, source, '部署初始技力', value);
        // 输入只有各盟约的在场人数，无法对同时属于多个盟约的队友去重，取所属各盟约“在场人数 − 1”的最大值。
        const members = new Set(context.memberBondIds ?? []);
        const others = Math.max(0, ...(context.bonds ?? []).filter(s => members.has(s.bondId)).map(s => s.activeChars - 1));
        e.initSp += value * others;
        assume(`迅捷作战粮：同盟约的其他干员按所属各盟约“在场人数 − 1”的最大值计（${others} 人，无法去重），额外初始技力 ${value} × ${others}`,
          value * others, `同盟约的其他干员按所属盟约在场人数 − 1 的最大值计（${others} 人）`);
        break;
      }
      case '叙拉古正装':
        // “携带者…左右两侧”只作用其他干员，不把光环加给携带者。
        add('attackSpeed', 'direct', nums('attr_common_global_buff').attack_speed!); break;
      case '灵巧涡轮手套': {
        const n = nums('act3autochess_equip_acarm132_global_buff');
        stack('second', n.atk_speed_layer_max!, 'attackSpeed', 'direct', n.attack_speed!);
        assume('灵巧涡轮手套：按部署后每秒叠层，假定携带者不受伤；未模拟受伤清空', n.atk_speed_layer_max!, '默认携带者不受伤，攻速每秒叠层不被清空');
        break;
      }
      case '乌萨斯呼吸器': {
        // “每次再部署时上述加成效果叠加”：一场只部署一次，没有再部署，只有 1 层。
        const n = nums('act3autochess_equip_acarm138_global_buff');
        add('atk', 'pct', n.atk_cell!);
        assume(`乌萨斯呼吸器：一场只部署一次，只计 1 层（攻击力 +${n.atk_cell! * 100}%），不计再部署叠层（最多 ${n.layer_max} 层）`, 1, '一场只部署一次，只计 1 层');
        break;
      }
      case '多功能补剂': {
        if (context.hasActiveMemberBond === false) break;
        const n = nums('act3autochess_equip_acarm131_global_buff');
        const prior = e.bondStacks;
        const perDamage = (prior?.perDamage ?? 0) + n.temp_stack_count_add!;
        const max = Math.max(prior?.max ?? 0, n.temp_stack_count_max!);
        e.bondStacks = { perDamage, max, source: prior?.max === max ? prior.source : source };
        record(e, source, '每次伤害临时盟约层数', n.temp_stack_count_add!);
        // PRTS「卫戍协议·规程/PRTS盟约记录」多功能补剂备注称获得量可叠加、上限不叠加（存疑）。
        // https://prts.wiki/w/盟约记录#多功能补剂
        if (prior) assume(`按多件补剂每击层数相加、上限取最高计算（PRTS 备注存疑）：每击 +${perDamage}，最多 ${max} 层`,
          max, `每击共增加 ${perDamage} 层，上限取最高的 ${max} 层`);
        note('近似：仅按本干员原攻击及附加伤害的已建模段数增加所属激活盟约，未计未建模伤害触发；同击结算后加层');
        break;
      }
      case '伊比利亚骨刺刀': {
        const n = nums('act3autochess_equip_acarm133_global_buff');
        // 描述两阶明确为1/2次，double_damage 是额外段数开关，不是倍率。
        e.extraHits.push({ type: 'arts', scale: n.atk_scale!, hits: 1 + n.double_damage!, source });
        record(e, source, '逐次伤害附加法术段数', 1 + n.double_damage!);
        record(e, source, '附加法术伤害攻击倍率', n.atk_scale!); break;
      }
      case '可靠怀表': {
        const n = nums('act3autochess_equip_acarm137_global_buff');
        e.spCostScale *= n.sp_cost_scale!; e.spCostMin = Math.max(e.spCostMin, n.sp_cost_min!);
        record(e, source, '技能技力消耗倍率', n.sp_cost_scale!);
        record(e, source, '技能技力消耗下限', n.sp_cost_min!);
        // 描述“-25%”与 blackboard -0.25 对照：百分比攻速，不是固定-25。
        add('attackSpeed', 'pct', n.attack_speed!, true); break;
      }
      case '佣兵名牌': {
        const n = nums('act3autochess_equip_acarm141_global_buff');
        add('atk', 'pct', n.atk! * Math.min(activeBondCount, n.max_layer!)); break;
      }
      case '动能单手弩': case '动能轰击弩': {
        // “造成伤害时有30%概率使该次攻击力提升至130%”：本体每段伤害逐次判定。
        const proc = nums('act3autochess_equip_acarm150_global_buff');
        e.atkProc = { probability: proc.prob!, scale: proc.atk_scale!, source };
        assume(`${equip.name}：本体每段伤害有 ${proc.prob! * 100}% 概率使该次攻击力 ×${proc.atk_scale}，按固定判定序列的成功占比（180 秒内判定数百次，与概率相差不到 1%）加权结算；附加伤害不触发`,
          proc.prob!, `概率提升攻击力按成功占比 ${proc.prob! * 100}% 结算`);
        if (equip.name === '动能单手弩') break;
        const n = nums('act3autochess_equip_acarm149_global_buff');
        stack('attack', n.layer_max!, 'attackSpeed', 'direct', n.attack_speed!);
        // “攻击速度叠加达到上限后每次攻击时有30%概率对攻击范围内随机敌人造成自身攻击力100%的范围物理伤害”：
        // 单 Boss 时随机敌人就是 Boss，只计对 Boss 的一段；splash_cd 是两次范围伤害的最短间隔。
        if (n.have_splash_damage) {
          e.splash = { probability: n.prob!, scale: n.atk_scale!, cooldown: n.splash_cd!, type: 'physical', fullAt: n.layer_max! * n.attack_speed!, source };
          assume(`动能轰击弩：攻速叠满 ${n.layer_max} 层后，每次攻击有 ${n.prob! * 100}% 概率追加攻击力 ${n.atk_scale! * 100}% 的物理伤害（冷却 ${n.splash_cd} 秒内不重复），只计对 Boss 的单目标部分`,
            n.prob!, '满层后的范围物理伤害只计对 Boss 的单目标部分');
        }
        break;
      }
      case '动能加速器': {
        const n = nums('act3autochess_equip_acarm149_global_buff');
        stack('attack', n.layer_max!, 'attackSpeed', 'direct', n.attack_speed!);
        break;
      }
      case '汲取者之心': case '汲取者之镰': {
        const n = nums('act3autochess_equip_acarm153_global_buff');
        add('atk', 'pct', n.atk!); add('attackSpeed', 'direct', n.attack_speed!);
        // 镰“技能期间上述效果翻倍”：额外加同一份，而不是把全局面板翻倍。
        if (n.can_double) { add('atk', 'pct', n.atk!, true); add('attackSpeed', 'direct', n.attack_speed!, true); }
        break;
      }
      case '天马之耀': {
        const value = nums('act3autochess_equip_acarm156_global_buff').atk_scale!;
        e.extraHits.push({ type: 'true', scale: value, hits: 1, source });
        record(e, source, '逐次伤害附加真实伤害攻击倍率', value); break;
      }
      case '精准狙击镜': {
        const n = nums('act1autochess_equip_acarm063_global_buff');
        if (context.targetDistance !== undefined && context.targetDistance < n.radius!) {
          assume(`精准狙击镜：目标距离 ${context.targetDistance} 格，未达到 ${n.radius} 格增伤条件`, 1, '狙击镜距离条件未满足');
          break;
        }
        increase(n.damage_scale!);
        assume(`精准狙击镜：默认目标距离携带者 ${n.radius} 格及以上，造成的伤害 ×${n.damage_scale}（与盟约增伤分区相乘）`, n.damage_scale!, `默认目标距离携带者 ${n.radius} 格及以上`);
        break;
      }
      case '卡西米尔竞技旗': {
        // “部署后15秒内造成的伤害提升至160%，随后逐渐衰减”：interval 15 秒后每 ex_interval 秒加 damage_scale_minus，降到 1 为止。
        // 模型假设：第 15 秒起立即进入第一档衰减，即 [15+0.5(k-1), 15+0.5k) 秒内为 1.6 − 0.07k。
        const n = nums('act2autochess_equip_acarm120_global_buff');
        e.timedDamageScale.push({ from: 0, until: n.interval!, scale: n.damage_scale!, source });
        for (let k = 1; k < 1000; k++) {
          const scale = n.damage_scale! + n.damage_scale_minus! * k;
          if (scale <= 1 + 1e-9) break;
          e.timedDamageScale.push({ from: n.interval! + n.ex_interval! * (k - 1), until: n.interval! + n.ex_interval! * k, scale, source });
        }
        const end = e.timedDamageScale.at(-1)!.until;
        assume(`卡西米尔竞技旗：部署后 ${n.interval} 秒内造成的伤害 ×${n.damage_scale}，之后每 ${n.ex_interval} 秒 ${n.damage_scale_minus}，第 ${end} 秒回到 ×1（与其他装备增伤相乘，同时生效的竞技旗也逐件相乘）；窗口总伤按各时段倍率结算`,
          n.damage_scale!, `部署后 ${n.interval} 秒内伤害 ×${n.damage_scale}，随后逐渐衰减，按命中时刻计入总伤`);
        break;
      }
      case '瓶装烈性反应': {
        // “对处于元素爆发状态的敌人造成的伤害额外增加30%/50%”：条件默认满足。
        const n = nums('act3autochess_equip_acarm158_global_buff');
        increase(n.damage_scale!);
        assume(`瓶装烈性反应：默认敌人始终处于元素爆发状态，造成的伤害 ×${n.damage_scale}（与盟约增伤分区相乘）`, n.damage_scale!, '默认敌人始终处于元素爆发状态');
        break;
      }
      case '驱逐者警棍': case '驱逐者防暴装备': {
        // “对受到晕眩、冻结、恐惧等异常效果影响的敌人造成的伤害提升30%”：跟随 Boss 免疫，
        // 点名的三种状态全部免疫时不计；其余按敌人已处于未免疫的状态计。传播与延长时长不影响输出。
        const n = nums('act3autochess_equip_acarm144_global_buff');
        const open = controlStates.filter(([key]) => !immune(key)).map(([, name]) => name);
        if (!open.length) {
          record(e, source, `${equip.name}：Boss 免疫晕眩、冻结、恐惧，条件增伤不计`, 0);
          e.assumptions.push(`【${equip.name}】Boss 免疫晕眩、冻结、恐惧，条件增伤不计`);
          break;
        }
        increase(n.damage_scale!);
        assume(`${equip.name}：默认敌人已通过其它方式处于${open.join('、')}状态，造成的伤害 ×${n.damage_scale}（与盟约增伤分区相乘）`, n.damage_scale!,
          `默认敌人已通过其它方式处于这些异常状态（${open.join('、')}）`);
        break;
      }
      default: note('尚未核对该装备的战斗效果');
    }
  }
}

export function equipCoverage(equip: EquipData): Coverage {
  if (equip.name === '变形同构体') return { status: '已建模', reason: '与带 giveBondId 的装备配对时授予对应盟约成员身份' };
  if (equip.name === '天马之盔') return { status: '已建模', reason: '单独携带只加生命；与天马之枪同时携带时组合为天马之耀计算' };
  if (equip.name === '汲取者之喙') return { status: '已建模', reason: '单独携带只回复生命；与汲取者之心同时携带时组合为汲取者之镰计算' };
  if (unrelated.has(equip.name)) return { status: '与 DPS 无关', reason: '生存、控制或局外效果；层数和阶级变动请体现在输入中' };
  const e = battleEffects();
  applyEquips(e, [equip], 1);
  // “近似：”开头的是已计入的模型假设，其余是未建模的部分。
  const gaps = e.notes.filter(n => !n.startsWith('近似：'));
  const modeled = e.derivation.length > 0;
  const assumed = e.notes.filter(n => n.startsWith('近似：')).map(n => n.slice(3));
  return { status: gaps.length ? modeled ? '部分' : '未建模' : '已建模',
    reason: gaps.join('；') || ['已计入携带者的战斗输出效果；不计对其他干员的光环', ...assumed].join('；') };
}
