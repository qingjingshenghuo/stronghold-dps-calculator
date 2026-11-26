import bondsJson from '../src/data/generated/bonds.json' with { type: 'json' };
import equipsJson from '../src/data/generated/equips.json' with { type: 'json' };
import operatorsJson from '../src/data/generated/operators.json' with { type: 'json' };
import { bondCoverage } from '../src/engine/effects/bonds.ts';
import { equipCoverage } from '../src/engine/effects/equips.ts';
import { calculate } from '../src/engine/calc.ts';
import type { BondData, EquipData, OperatorData } from '../src/engine/types.ts';
import type { Coverage } from '../src/engine/effects/common.ts';
const bonds = bondsJson as BondData[];
const equips = equipsJson as EquipData[];
const operators = operatorsJson as unknown as OperatorData[];
export function effectsCoverage() {
  const escape = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const summary = (rows: Coverage[]) => ['已建模','部分','未建模','与 DPS 无关'].map(status => `${status} ${rows.filter(r=>r.status===status).length}`).join('；');
  const bondRows = bonds.map(b=> { const c=bondCoverage[b.bondId]; if(!c) throw new Error(`缺少盟约状态 ${b.bondId}`); return `| ${b.bondId} ${b.name} | ${c.status} | ${escape(c.reason)} |`; });
  const equipRows = equips.map(e=> {const c=equipCoverage(e); return `| ${e.chessId} ${e.name} | ${c.status} | ${escape(c.reason)} |`; });
  const samples = [
    ['char_4133_logos','chess_item_3_07_e_a'], ['char_180_amgoat','chess_item_4_09_e_a'],
    ['char_4064_mlynar','chess_item_4_04_e_a'], ['char_4247_oxi','chess_item_3_12_e_a'],
    ['char_1046_sbell2','chess_item_4_10_e_a'],
  ];
  const sampleRows: string[] = [];
  for(const [id,equipId] of samples) {
    const op=operators.find(o=>o.charId===id)!;
    const settings=op.bondIds.map(bondId=>({bondId,stacks:10,activeChars:bonds.find(b=>b.bondId===bondId)!.activeCount}));
    for(const equipment of [[],[equipId]]) {
      const r=calculate({charId:id,tier:'b',skillId:op.skillIds[op.defaultSkillIndex],bonds:settings,equips:equipment,bossId:'boss_1',modeId:'mode_single_10',durationSec:180});
      if(!Number.isFinite(r.totalDamage.value)) throw new Error(`样例伤害无效 ${id}`);
      sampleRows.push(`| ${op.name} | ${r.input.skillId} | ${equipment.length ? equips.find(e=>e.chessId===equipId)!.name+'（普通）' : '无'} | ${r.normal.dps.toFixed(2)} | ${r.skill?.dps.toFixed(2) ?? '—'} | ${r.cycle?.avgDps.toFixed(2) ?? '—'} | ${(r.totalDamage.value/180).toFixed(2)} | ${r.accuracy} |`);
    }
  }
  return `\n## 盟约、装备与卫戍特质\n\n盟约 ${bonds.length} 项：${summary(bonds.map(b=>bondCoverage[b.bondId]))}。\n\n装备 ${equips.length} 件（两阶分别统计）：${summary(equips.map(equipCoverage))}。状态表示该项对携带者的DPS建模范围，非DPS部分静默跳过；“已建模”仍服从时间过程的近似假设。\n\n### 逐盟约\n\n| 盟约 | 状态 | 已计入及未计入原因 |\n|---|---|---|\n${bondRows.join('\n')}\n\n### 逐装备\n\n| 装备 | 状态 | 原因 |\n|---|---|---|\n${equipRows.join('\n')}\n\n### 参数与时间过程口径\n\n- 盟约满足activeCount才生效，powerCount阈值另判；成员来自干员bondIds；变形同构体与带 giveBondId 的装备配对时赋予对应盟约成员身份。全体效果、精准远程扩展和调和核心盟约享受权单独处理。装备不自动增加activeChars，避免用户输入重复计人。独行只在1人生效，精锐只影响b阶。\n- *_max按效果值截断，不截层数：慢速上限0.6、法伤上限100000、概率上限1均有量纲；奥术负减抗取max(-100,-30-0.05×层数)，转正后为固定减抗上限。atk_buff_cnt、layer_max等明确“最多叠加N次”的参数才是层数上限。炎攻击无atk_max，因此不存在该项硬上限。\n- 炎国短刀在每次技能开启时增层；动能装备在一次攻击/治疗完整间隔结束时增层；涡轮手套在部署后整秒增层，受伤频率缺失，假定不受伤并标近似。非技能期面板取第一次开技能前一刻的层数，技能期面板取第一次开技能时的层数；总伤与循环平均（180 秒总伤 ÷ 180）保留逐步叠层。专属模型的时间轴不逐事件读叠层时，按触发时刻分段换用叠层后的静态面板，标近似。\n- 条件类装备默认条件满足（精准狙击镜默认目标在3格以外、瓶装烈性反应默认敌人处于元素爆发、终极维式重锤按输入的场上重锤计算，缺省5种带特殊效果的重锤都在场，只继承在场重锤的效果）；异常状态条件跟随 Boss 免疫：电流维式重锤看麻痹，驱逐者警棍/防暴装备看晕眩、冻结、恐惧，全部免疫时不计。装备增伤各自分区，与盟约增伤及彼此相乘。卡西米尔竞技旗按部署后时间的伤害倍率放大累计伤害；灼燃维式重锤按法术伤害循环占比×10%积累灼燃条，爆条计7000元素伤害（过元素伤害抗性）与10秒法抗-20；两者只进总伤与击杀，面板不含。动能弩的概率攻击力按固定判定序列的成功占比加权（防御前结算），轰击弩满层后按概率与0.5秒冷却追加单目标物理伤害。同时携带可组合的两件装备时按描述组合为一件。迅捷作战粮的同盟约其他干员取所属各盟约在场人数−1的最大值。\n- 有限叠层和限时效果生成事件前缀，之后使用固定周期积分；伤害仍按连续DPS积分，非逐帧模拟。技能开启先获得本次层数再算技能，攻击后叠层不追溯修改刚完成的攻击。弹药/下次攻击的剩余进度随攻速变化调整。\n- 多功能补剂按本干员已建模伤害段数逐次增加所属且已激活的盟约临时层数，达到数据上限停止；重算对应盟约和持续型卫戍特质，自然技力回复同步更新；部署触发的限时属性保留初始层数快照。同击后统一加层，未建模伤害事件不额外猜测，标近似。\n- 乌萨斯呼吸器一场只部署一次，只计 1 层。突袭成员按全程满足再部署条件计入攻击力加成，达到50层后全体攻速另加50。\n- 三人卡西米尔从开场起全程按当前盟约层数的部署加攻上限计。六人真伤只在部署后30秒及每次开技后30秒内生效（窗口重叠不叠加），每次本体攻击只附加一次，多段或多目标共用一次触发；被击倒召唤干员忽略。\n- 三人萨尔贡从开场起全程按攻速增益叠满计，每层+12，最多25层，共+300。六人只计本干员首次开技生成的一块常驻流沙，假设目标此后始终在其中。生成后第5秒起每5秒结算法伤，持续技能每满1秒另结算法伤。两种伤害分别过法抗，普通面板取部署时，技能面板列出地面生效时两项各自的伤害率。\n- 叙拉古部署攻速按base_duration+duration_per_stack×层数到期移除；六人默认策略假设敌人始终有2种以上异常状态，从部署起每秒一次真伤计入每名成员。谢拉格默认敌人始终寒冷或冻结，增伤取 base_ex_damage_scale+每层0.01，与维多利亚增伤分区相乘。伊比利亚持续法伤直接按叠满10层、每秒按当前攻击力结算，六人×2，弹射忽略。迅捷每次技能结束时判定回技，成员与40层全场加成共用判定。180秒代表时间轴开技至多10次时，按分支概率计算窗口总伤与平均DPS；超过10次时采用均匀确定序列。卫戍特质部署30秒/100秒加成同样到期移除。附伤各自过防御/法抗，按原攻击伤害段数触发，不递归；弱点伤害（双模机械臂、卫戍特质）逐段按物理、法术各结算一遍取较高者，按实际类型触发灼燃积累与按类型的增伤，持续伤害保持原类型；在场3奥术时，全场从开场起按固定减抗上限计，标近似。\n- 卫戍GAIN_BUFF的attrByBond读取对应盟约层数；每N层取完整组，多个盟约通常各自整除后相加，这项解释尚未在游戏中验证，结果带近似。逻各斯的进阶攻速效果按合计层数取完整组。艾雅法拉普通每2层+1%攻击/+0.02自然技力，进阶每1层同增益。初始技力、自然回复、消耗倍率分别进入时间轴，攻击/受击回复不加自然回复。\n- ADD_BOND/SERVER_* 的层数由输入给定。逻各斯的 garrison_92_a/b 含战斗攻速字段，单独计入攻速。\n- 前置条件跨逗号保留；“始终不会低于/高于”是独立保底/上限效果，不把条件带到后面的攻击力加成。“每次射击造成/每次造成数值伤害”为逐击描述，每N秒/每N次/每层仍属条件。灰喉一技能计入攻击倍率，连射次数尚未覆盖。\n\n### 样例配置\n\n全部b阶、默认技能、boss_1 / mode_single_10、180秒；自身各盟约stacks=10、activeChars=activeCount（激活但不额外凑强化）。相关装备依giveBondId选普通阶；部分装备仅生存或未支持条件效果，因此样例中的 DPS 可能相同。两期面板DPS与180秒平均分别列出。\n\n| 干员 | 技能 | 装备 | 普攻DPS | 技能DPS | 循环平均DPS | 180秒均DPS | accuracy |\n|---|---|---|---:|---:|---:|---:|---|\n${sampleRows.join('\n')}\n`;
}
