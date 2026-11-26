import type { BondData, BondSetting, EquipData, OperatorData, OperatorTierData } from '../types.ts';
import { record } from './common.ts';
import type { BattleEffects, Coverage } from './common.ts';

// *_max 是效果值上限：slow_max=.6、magic_damage_max=100000、big_prob_max=1均有量纲；
// 不是层数上限。magic_res_max_min=-100 是负减抗值的下界，取绝对值后变为100点上限。
export function stacked(n: Record<string, number>, name: string, stacks: number) {
  return Math.min(n[`${name}_max`] ?? Infinity,
    (n[`${name}_base`] ?? n[`base_${name}`] ?? 0) + (n[`${name}_per_stack`] ?? 0) * stacks);
}
export const bondCoverage: Record<string, Coverage> = {
  yanShip: { status: '已建模', reason: '攻击百分比；强化随机元素损伤不计入扣血 DPS，忽略并注明' },
  sargonShip: { status: '已建模', reason: '成员从开场全程按攻速上限计，首次开技后计入自身一块常驻流沙的周期法伤和技能期额外法伤' },
  victoriaShip: { status: '已建模', reason: '带装备时增伤（与谢拉格分区相乘）；强化按普通/进阶装备数量进百分比加攻区；赠送装备不计' },
  kjeragShip: { status: '已建模', reason: '默认敌人始终寒冷或冻结，增伤取额外增伤并随层数提升；强化雪山巨人忽略' },
  egirShip: { status: '部分', reason: '吞噬基础攻击力由输入给定；生命/复活不计' },
  siracusaShip: { status: '已建模', reason: '部署限时攻速按真实时限；默认强化按敌人始终有2种以上异常状态每秒真伤计入成员；裁度按概率限时真伤' },
  kazimierzShip: { status: '已建模', reason: '成员从开场按部署加攻上限计；强化后部署及每次开技后30秒内每次本体攻击附带一次真伤；被击倒召唤忽略' },
  ursusShip: { status: '已建模', reason: '只计攻击百分比；临时层数与强化阻挡法伤忽略并注明' },
  iberiaShip: { status: '已建模', reason: '持续法伤直接按叠满10层、每秒按当前攻击力结算；强化×2，弹射忽略' },
  lethaniaShip: { status: '已建模', reason: '干员与召唤物攻击百分比；强化“一个乐部”攻速忽略（召唤物数量不定）' },
  preciShip: { status: '已建模', reason: '攻击百分比；强化百分比物穿/法穿及远程作用域' },
  swiftShip: { status: '已建模', reason: '每次技能结束独立判定整笔回技，40层后全体额外回复；零时长技能续开至少间隔一个攻击间隔' },
  skillfulShip: { status: '已建模', reason: '成员及 inRange 标记覆盖的非成员攻速' },
  steadShip: { status: '已建模', reason: '3人强化假设 Boss 持续攻击坚守干员，按常驻脆弱；反伤忽略' },
  deputShip: { status: '与 DPS 无关', reason: '防御、再部署、休整期层数不改变当前攻击伤害' },
  visiShip: { status: '与 DPS 无关', reason: '资金及商店价格' },
  miraShip: { status: '与 DPS 无关', reason: '商店刷新' },
  investShip: { status: '与 DPS 无关', reason: '获得时特质触发次数' },
  raidShip: { status: '已建模', reason: '成员按全程满足再部署加攻条件计，50层时全体攻速提升' },
  indomShip: { status: '未建模', reason: '击倒重部署/全体技力缺队友死亡事件' },
  maniShip: { status: '已建模', reason: '激活时成员享受激活核心盟约；层数/激活人数由输入控制' },
  emptyShip: { status: '已建模', reason: '协防成员普通1.2/精锐1.4最终增伤；全体己方减伤不计' },
  soloShip: { status: '已建模', reason: '仅在场1名时攻击百分比和初始技力，2名及以上失效' },
  suntShip: { status: '已建模', reason: '精锐阶级2人加攻/5人技力消耗乘算' },
  docShip: { status: '与 DPS 无关', reason: '回复生命/元素损伤及庇护' },
  arcaneShip: { status: '部分', reason: '成员逐伤害附加法伤；强化后全场从开场起按减抗上限计（模型假设）' },
};
const core = new Set(['yanShip','sargonShip','victoriaShip','kjeragShip','egirShip','siracusaShip','kazimierzShip','ursusShip','iberiaShip','lethaniaShip']);
/** 实际的盟约成员身份，去重并保留自身盟约在前。 */
export function memberBondIds(operator: OperatorData, equipChessIds: string[], equips: EquipData[]): string[] {
  const ids = new Set(operator.bondIds);
  const isomorph = 'chess_item_6_03_e_a';
  if (equipChessIds.includes(isomorph)) {
    // character_table 中 trap_1073_acarm073 的天赋列出配对，activity_table.trapChessDataDict 提供 giveBondId。
    const byId = new Map(equips.map(equip => [equip.chessId, equip]));
    for (const chessId of equipChessIds) {
      const bondId = byId.get(chessId)?.giveBondId;
      if (chessId !== isomorph && bondId != null) ids.add(bondId);
    }
  }
  return [...ids];
}
export function applyBonds(e: BattleEffects, data: BondData[], settings: BondSetting[], operator: OperatorData, tier: OperatorTierData, equips: EquipData[]) {
  const byId = new Map(data.map(b => [b.bondId, b]));
  const ids = new Set(memberBondIds(operator, equips.map(equip => equip.chessId), equips));
  const harmony = ids.has('maniShip') && settings.some(s => s.bondId === 'maniShip' && s.activeChars >= byId.get(s.bondId)!.activeCount);
  for (const s of settings) {
    const b = byId.get(s.bondId)!;
    if (s.activeChars < b.activeCount) continue;
    const member = ids.has(b.bondId) || harmony && core.has(b.bondId);
    const power = b.powerCount !== null && s.activeChars >= b.powerCount;
    const source = `bond:${b.bondId}`;
    const variant = ids.has('siracusaShip') && b.bondId === 'siracusaShip'
      ? b.variants?.find(v => v.bandId === s.bandId) : undefined;
    const n = (variant?.buffs ?? b.buffs)[0]?.blackboard.nums ?? {};
    const val = (key: string) => stacked(n, key, s.stacks);
    const stat = (stat: 'atk' | 'attackSpeed', value: number) => e.stats.push({ stat, bucket: stat === 'atk' ? 'pct' : 'direct', value, source });
    const note = (why: string) => e.notes.push(`近似：${source} ${why}`);
    /** 模型假设：写进计算过程与 notes（近似：），并给界面一条短说明。 */
    const assume = (label: string, value: number, display: string) => {
      record(e, source, label, value);
      note(label);
      e.assumptions.push(`【${b.name}】${display}`);
    };
    const inc = (scale: number) => e.modifiers.push({ group: `盟约增伤（${b.name}）`, kind: 'increase', value: scale - 1, source });
    // 全场效果先于成员专属效果结算。
    if (b.bondId === 'arcaneShip' && power) {
      const enemy = b.buffs[1].blackboard.nums;
      const max = -Math.max(enemy.magic_res_max_min, enemy.magic_res_max_base + enemy.magic_res_max_per_stack * s.stacks);
      // 游戏中减抗随目标逐次受击叠加，模型近似为全程叠满。
      e.resReductionFixed += max;
      assume('全场奥术减抗：按敌人已叠满减抗计算（直接按上限）', max, '默认敌人已叠满法术抗性降低');
    }
    if (b.bondId === 'raidShip' && s.stacks >= n.power_bond_stack_cnt) {
      stat('attackSpeed', n.power_attack_speed);
      record(e, source, `突袭达到 ${n.power_bond_stack_cnt} 层，全体干员攻速 +${n.power_attack_speed}`, n.power_attack_speed);
    }
    if (b.bondId === 'swiftShip') {
      const sp = (member ? n.normal_sp : 0) + (s.stacks >= n.power_bond_stack_cnt ? n.power_sp : 0);
      // 同一个 buff 只列出一组概率，模型据此让成员回复与强化回复共用一次判定。
      e.skillEndSp = sp;
      e.skillEndProbability = Math.min(1, val('prob'));
    }
    if (b.bondId === 'skillfulShip' && (member || s.inRange === true)) {
      stat('attackSpeed', val('attack_speed'));
      if (!member) assume('灵巧：默认本干员处于灵巧干员周围', val('attack_speed'), '默认干员处于【灵巧】干员周围');
    }
    if (b.bondId === 'steadShip' && power) {
      e.modifiers.push({ group: '脆弱', kind: 'fragile', value: n.damage_scale - 1, source });
      // 模型假设：Boss 持续攻击坚守干员，脆弱常驻；受击反伤的法术伤害不计入。
      assume(`坚守：假设 Boss 持续攻击坚守干员，${n['weak[limit]']} 秒脆弱常驻覆盖；受击反伤忽略`, n.damage_scale, '只计脆弱增伤，反伤忽略');
    }
    if (b.bondId === 'indomShip' && power) note('地面队友被击倒触发的全体技力未建模');
    // 精准“所有远程干员”按部署位置识别，包括可在远程位部署的干员。
    const ranged = operator.position === 'RANGED' || operator.position === 'ALL';
    if (!member && !(b.bondId === 'preciShip' && power && ranged) && !(b.bondId === 'suntShip' && tier.chessId.endsWith('_b'))) continue;
    switch (b.bondId) {
      // “【炎】干员攻击力提升”：atk_base/per_stack → 面板百分比；强化不计随机元素扣血。
      case 'yanShip': stat('atk', val('atk'));
        // 元素损伤本身不计入扣血 DPS，随机元素的爆发分布无法确定。
        if (power) assume('六人炎：随机元素损伤忽略', n.ex_atk_scale_base, '6 人随机元素损伤忽略'); break;
      case 'sargonShip': {
        // bondeffect_sargon_2 的效果说明给出每次开技 +12、至多 +300。模型假设开场即叠满，全程生效。
        const speed = n.base_attack_speed * n.max_buff_stack_cnt;
        stat('attackSpeed', speed);
        assume(`萨尔贡从开场起按 ${n.max_buff_stack_cnt} 层攻速上限全程计算（直接按上限），每层 +${n.base_attack_speed}，合计 +${speed}`, speed, `攻击速度直接按叠满（+${speed}）计算`);
        if (power) {
          const root = 'act3autochess_bond_eff_sargon_power';
          const tile = b.buffs.find(buff => buff.blackboard.strs?.key === `${root}[tile_listener]`)!.blackboard.nums;
          const pulse = `${root}[tile_buff][mag_damage]`;
          // 模型假设：首次开技后，目标始终位于本干员生成的一块流沙上。
          e.quicksand = {
            interval: tile[`${pulse}.interval`],
            firstDelay: tile[`${pulse}.first_trigger_interval`],
            damage: stacked(tile, `${pulse}.magic_damage`, s.stacks),
            skillDamage: stacked(tile, `${root}[tile_buff][mag_damage_2].magic_damage`, s.stacks),
          };
          assume('六人萨尔贡从本干员首次开技起只计自身一块流沙，此后流沙常驻，默认敌人始终位于流沙上', 1, '默认敌人始终位于流沙上');
        }
        break;
      }
      // “携带装备…伤害提升”；“每携带1件装备攻击力提升，携带进阶装备时额外提升”。
      case 'victoriaShip':
        if (equips.length) inc(val('damage_scale'));
        if (power) stat('atk', equips.reduce((sum, x) => sum + n.atk_normal_equip + (x.tier === 'b' ? n.atk_golden_equip : 0), 0));
        break;
      // “造成的伤害提升，对寒冷、冻结敌人获得额外提升（受层数影响）”：模型假设敌人始终寒冷或冻结，
      // 取 base_ex_damage_scale + ex_damage_scale_per_stack × 层数 代替基础 base_damage_scale（不叠乘）。
      case 'kjeragShip': {
        const scale = n.base_ex_damage_scale + n.ex_damage_scale_per_stack * s.stacks;
        inc(scale);
        assume(`谢拉格：默认敌人始终处于寒冷或冻结，伤害倍率取 ${n.base_ex_damage_scale} + ${n.ex_damage_scale_per_stack}×层数`, scale, '默认敌人始终处于寒冷或冻结');
        if (power) assume('六人谢拉格：雪山巨人伤害忽略', 0, '雪人伤害忽略');
        break;
      }
      case 'egirShip': {
        if (!ids.has(b.bondId)) break;
        const atk = s.devouredAtk;
        // 从主人面板推导的残影随面板提升；自带面板的召唤物（如小自在、魂灵之影）使用独立的属性修饰列表。
        if (typeof atk === 'number' && Number.isFinite(atk) && atk > 0) {
          e.stats.push({ stat: 'atk', bucket: 'finalAdd', value: atk, source });
          record(e, source, '阿戈尔吞噬：与百分比加攻同区加算', atk);
        } else if (atk === undefined) note('未填写吞噬基础攻击力');
        break;
      }
      case 'siracusaShip': {
        const duration = val('duration');
        e.timedStats.push({ until: duration, modifier: { stat: 'attackSpeed', bucket: 'direct', value: val('attack_speed'), source } });
        if (variant && s.activeChars >= n.power_bond_char_cnt) {
          const until = duration + n.end_duration;
          e.judgment = { until, probability: n.prob, damage: val('damage') };
          record(e, source, '裁度真伤只在部署后窗口内生效（秒）', until);
          e.caveats.push(`裁度真伤只在部署后 ${until} 秒内由干员对敌攻击触发。`);
        } else if (power && !variant) {
          // 模型假设：敌人始终处于 2 种以上异常状态，“每秒…造成一次真实伤害”从部署起每秒结算，计入每名叙拉古成员。
          const damage = n.damage_value_base + n.damage_value_per_stack * s.stacks;
          e.periodic.push({ type: 'true', damage, interval: 1, source: `${source}:abnormal`, label: '六人叙拉古异常状态每秒真伤' });
          assume(`六人叙拉古：默认敌人始终处于 2 种以上异常状态，每秒 ${damage} 点真实伤害计入本成员`, damage, '默认敌人始终处于 2 种以上异常状态');
        }
        break;
      }
      // 模型假设：部署触发的攻击力加成从开场起就达到当前盟约层数对应的上限。
      case 'kazimierzShip': {
        const atk = val('max_atk_when_born');
        stat('atk', atk);
        assume(`卡西米尔从开场起按部署加攻上限计算（直接按上限），全程攻击力 +${Math.round(atk * 100)}%`, atk, '攻击力直接按叠到上限计算');
        if (power) {
          const scale = val('ex_atk_scale');
          const duration = n.ex_damage_duration;
          e.kazimierz = { scale, duration };
          // “开启技能或部署后30秒内攻击时附带…真实伤害”：窗口为部署后与每次开技后 duration 秒，重叠不叠加。
          // PRTS 记为“攻击时”，按本体攻击动作触发，多段或多目标只触发一次。https://prts.wiki/w/卫戍协议·规程/PRTS盟约记录
          record(e, source, `六人卡西米尔：部署后与每次开技后 ${duration} 秒内，每次本体攻击附带攻击力 ${Math.round(scale * 100)}% 的真实伤害`, scale);
          assume('六人卡西米尔：被击倒后召唤整备区干员的效果忽略', 0, '被击倒后召唤干员的效果忽略');
        }
        break;
      }
      // “攻击力和生命值提升”：atk → 面板百分比；临时层数由用户输入。
      case 'ursusShip': stat('atk', val('atk'));
        assume('乌萨斯：只计攻击力提升；击倒叠加的临时层数与强化后的阻挡法伤忽略', val('atk'), '临时层数与阻挡敌人的法术伤害忽略'); break;
      // “每次造成伤害时，使目标每秒受到该单位攻击力一定比例的持续法术伤害…至多叠加10次，持续10秒”；
      // 强化“持续法术伤害提升至2倍”。模型假设从部署起即叠满10层（10 取自盟约描述），每秒按当前面板结算；弹射忽略。
      case 'iberiaShip': {
        const layers = 10;
        const scale = layers * val('dot_atk_scale') * (power ? 2 : 1);
        e.dots.push({ type: 'arts', scale, interval: 1, source: `${source}:dot`, label: `伊比利亚持续法伤（叠满${layers}层${power ? '，强化×2' : ''}）` });
        assume(`伊比利亚：持续法伤直接按叠满 ${layers} 层计算，每秒攻击力 ×${+scale.toFixed(4)} 的法术伤害`, scale, '持续法术伤害直接按叠满计算');
        if (power) assume('六人伊比利亚：只计持续法伤提升至2倍，概率弹射忽略', n.atk_scale, '弹射忽略');
        break;
      }
      // “干员和召唤物攻击力提升”：面板百分比同样作用于由主人面板推导的召唤物。
      case 'lethaniaShip': stat('atk', val('atk'));
        if (power) assume('六人莱塔尼亚：“一个乐部”攻速提升忽略，无法确定场上召唤物数量', 0, '「一个乐部」攻速提升忽略（无法确定场上召唤物数量）'); break;
      // “攻击力提升…攻击无视一定的防御力和法术抗性”：百分比穿透，非目标减抗。
      case 'preciShip': stat('atk', val('atk')); if (power) {
        e.defPenetrationPct = Math.max(e.defPenetrationPct, n.power_def_penetrate);
        e.resPenetrationPct = Math.max(e.resPenetrationPct, n.power_magic_resist_penetrate);
        record(e, source, '百分比物穿/法穿', n.power_def_penetrate);
      } break;
      // “所有干员防御力提升，再部署时间减少”；休整期叠层由输入控制。
      case 'deputShip': break;
      // 远见“获得资金/购买价格”、奇迹“刷新调度中心”、投资人“获得时类特质”。
      case 'visiShip': case 'miraShip': case 'investShip': break;
      // 模型假设：突袭成员全程满足再部署加攻条件。
      case 'raidShip': {
        const atk = val('atk');
        stat('atk', atk);
        assume(`突袭按全程满足再部署条件计算（范围内无敌人，且 ${n.no_attack_duration} 秒内未攻击或技能已就绪），成员攻击力 +${Math.round(atk * 100)}%`, atk, '默认【突袭】干员吃到再部署加攻');
        break;
      }
      // “地面干员被击倒…重新部署”：本模型不预测死亡。
      case 'indomShip': break;
      // “【调和】干员享受已激活的核心盟约的效果”：上方member扩展；人数输入由用户给定。
      case 'maniShip': e.caveats.push('调和提高核心盟约激活人数的影响请直接体现在盟约激活配置中'); break;
      // “协防干员伤害提升至120%，精锐…140%”：成员最终增伤，不加给其他干员。
      case 'emptyShip': inc(tier.chessId.endsWith('_b') ? n.damage_scale_extra : n.damage_scale_normal); break;
      // “在场1名…攻击力+60%，初始技力+15（在场2名及以上…失效）”。
      case 'soloShip': if (s.activeChars === 1) { stat('atk', n.atk); e.initSp += n.sp; record(e, source, '初始技力加算', n.sp); } break;
      // “2名精锐…攻击力+30%；5名精锐…技力消耗-30%”。
      case 'suntShip': if (tier.chessId.endsWith('_b')) { if (s.activeChars >= n.power_char_cnt) stat('atk', n.power_atk); if (s.activeChars >= n.ex_char_cnt) { e.spCostScale *= n.sp_ratio; record(e, source, '技力消耗乘算', n.sp_ratio); } } break;
      // “每秒回复…生命值和元素损伤…庇护”：不计扣血DPS。
      case 'docShip': break;
      // “造成伤害时，额外附加一次…法术伤害”：独立法伤分项，atk_base不是面板百分比。
      case 'arcaneShip': e.extraHits.push({ type: 'arts', scale: val('atk'), hits: 1, source }); record(e, source, '逐次伤害附加法伤倍率', val('atk')); note('按盟约描述及PRTS，本体独立伤害各触发一次奥术，逐击行为尚无模式内实测'); break;
    }
    for (const buff of b.buffs) for (const key of Object.keys(buff.blackboard.nums)) {
      if (/^(?:hp_|max_hp|base_max_hp|heal_|ep_heal|damage_res|base_def|def_per_stack|respawn_time)|move_speed|ep_break_recover_speed|\.slow_(?:base|per_stack|max)$|unmovable_duration/.test(key)) e.ignoredKeys.push(`${source}:${key}`);
    }
  }
}
