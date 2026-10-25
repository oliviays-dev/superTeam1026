/**
 * 核心指标 / 供给例外 / 供应商风险目前没有对应的平台业务域。
 * 经产品确认，本期由工作台聚合 API 先提供演示 / 种子数据，
 * 待真实域接入后替换为领域数据。
 */

export interface MetricDefinition {
  id: string;
  label: string;
  value: string;
  unit: string;
  trend: string;
  trendClass: "up" | "down";
  target: string;
  description: string;
  spark: number[];
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    id: "otif",
    label: "OTIF",
    value: "94.2",
    unit: "%",
    trend: "+0.8pt",
    trendClass: "up",
    target: "目标 95% · 差距 0.8pt",
    description: "订单足量、准时送达率",
    spark: [8, 12, 52, 46, 68, 74, 58, 38, 31],
  },
  {
    id: "inventory-turn",
    label: "库存周转天数",
    value: "38.6",
    unit: "天",
    trend: "-1.6天",
    trendClass: "up",
    target: "目标 36 天 · 高价值库存占比 28%",
    description: "存货变现速度与资金占用",
    spark: [82, 76, 71, 64, 55, 58, 51, 48, 42],
  },
  {
    id: "supplier-otd",
    label: "供应商准时率",
    value: "92.7",
    unit: "%",
    trend: "-2.4pt",
    trendClass: "down",
    target: "2 家供应商低于阈值",
    description: "承诺到货时间达成情况",
    spark: [78, 74, 70, 66, 61, 48, 41, 34, 29],
  },
  {
    id: "price-achievement",
    label: "采购价格达成",
    value: "101.4",
    unit: "%",
    trend: "+1.4%",
    trendClass: "up",
    target: "连接器 -3.8% · 铜材 +2.1%",
    description: "关键物料价格对比基线",
    spark: [41, 46, 44, 62, 58, 68, 72, 78, 84],
  },
  {
    id: "supply-risk",
    label: "供应风险指数",
    value: "63",
    unit: "",
    trend: "+3.0",
    trendClass: "down",
    target: "目标 ≤60 · 2 项单源高风险",
    description: "产能、质量和单源依赖综合评分",
    spark: [38, 42, 45, 48, 52, 56, 58, 62, 63],
  },
];

export const DEFAULT_METRIC_IDS = [
  "otif",
  "inventory-turn",
  "supplier-otd",
  "price-achievement",
] as const;

export interface SupplyExceptionSeed {
  id: string;
  severity: "high" | "medium" | "watch";
  title: string;
  recommendation: string;
  owner: string;
  deadline: string;
  impact: string;
  related: { label: string; route: "task" | "workflow"; refId: string }[];
}

export const SUPPLY_EXCEPTIONS: readonly SupplyExceptionSeed[] = [
  {
    id: "SUP-2200",
    severity: "high",
    title: "A-2200 高压阀体供给缺口 320 件",
    recommendation: "释放安全库存 120 件；确认苏州汇川 200 件 48 小时产能。",
    owner: "Peter",
    deadline: "18:00 前决策",
    impact: "影响 3 张关键客户订单",
    related: [],
  },
  {
    id: "WF-197-BLOCK",
    severity: "medium",
    title: "客户迁移发布停留在回滚确认",
    recommendation: "确认最大可接受停机时间后继续发布节点。",
    owner: "Olivia",
    deadline: "SLA 剩余 6 小时",
    impact: "阻塞节点：回滚确认",
    related: [
      { label: "查看流程", route: "workflow", refId: "WF-197" },
    ],
  },
];

export interface CoverageSeed {
  material: string;
  days: number;
  safeDays: number;
}

export const COVERAGE_ITEMS: readonly CoverageSeed[] = [
  { material: "A-2200 阀体", days: 4.2, safeDays: 7 },
  { material: "伺服电机", days: 8.4, safeDays: 7 },
  { material: "连接器", days: 14.6, safeDays: 7 },
  { material: "包装材料", days: 11.2, safeDays: 7 },
];

export interface SupplierRiskSeed {
  id: string;
  score: number;
  level: "high" | "medium" | "watch";
  name: string;
  riskType: string;
  metric: string;
  share: string;
  recommendation: string;
}

export const SUPPLIER_RISKS: readonly SupplierRiskSeed[] = [
  {
    id: "SUP-HUICHUAN",
    score: 72,
    level: "medium",
    name: "苏州汇川",
    riskType: "产能受限",
    metric: "10 月承诺完成率 87%，连续 2 周低于目标",
    share: "采购份额 34%",
    recommendation: "分散 20% 到备用产能",
  },
  {
    id: "SUP-NINGBO",
    score: 81,
    level: "watch",
    name: "宁波精工",
    riskType: "来料批退上升",
    metric: "近 30 天批退 2.1%，主要来自表面处理工序",
    share: "采购份额 18%",
    recommendation: "SQE 现场复盘",
  },
];

export const SUPPLIER_RESILIENCE_NOTE =
  "单源物料占比 18%，其中 2 项没有合格备用产能；建议本月完成替代方案评审。";
