/**
 * 工作计划的确定性自然语言解析。
 *
 * 解析结果只作为服务端校验与前端预填的依据：
 * - 标题：取第一句去掉敬语与优先级短语后的短句；
 * - 优先级：命中的 P0–P3（产品展示口径），默认 P2；
 * - 截止日期：显式中文或数字日期，默认 T+1；
 * - 项目：命中调用者可见工作区名称时使用，否则回落到默认工作区。
 *
 * 选择器值永远优先于解析预填值，这里只负责产出建议值。
 */

const TITLE_MAX_LENGTH = 42;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date: Date, days: number): string {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return isoDate(next);
}

export function compactWorkPlanTitle(text: string): string {
  const firstSentence = String(text ?? "").split(/[。\n；;]/)[0] ?? "";
  let title = firstSentence.trim();
  title = title.replace(/^(请|帮我|麻烦|让\s*Agent\s*)+/, "");
  title = title.replace(/[,，、]\s*优先级[:：]?\s*P[0-3]/gi, "");
  title = title.replace(/\s*优先级[:：]?\s*P[0-3]/gi, "");
  title = title.trim();
  if (title.length > TITLE_MAX_LENGTH) {
    title = `${title.slice(0, TITLE_MAX_LENGTH)}...`;
  }
  return title || "新的 AI伙伴工作计划";
}

export function parseWorkPlanPriority(text: string): string | undefined {
  const match = String(text ?? "").match(
    /(?:^|[^A-Za-z0-9])(P[0-3])(?=$|[^A-Za-z0-9])/i,
  );
  return match?.[1]?.toUpperCase();
}

export function parseWorkPlanDueDate(
  text: string,
  now: Date = new Date(),
): string | undefined {
  const value = String(text ?? "");
  if (/今天/.test(value)) return addDays(now, 0);
  if (/明天/.test(value)) return addDays(now, 1);
  if (/后天/.test(value)) return addDays(now, 2);
  const full = value.match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (full !== null) {
    return `${full[1]}-${pad(Number(full[2]))}-${pad(Number(full[3]))}`;
  }
  const chinese = value.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (chinese !== null) {
    return `${now.getFullYear()}-${pad(Number(chinese[1]))}-${pad(Number(chinese[2]))}`;
  }
  const short = value.match(/(?<!\d)(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/);
  if (short !== null) {
    return `${now.getFullYear()}-${pad(Number(short[1]))}-${pad(Number(short[2]))}`;
  }
  return undefined;
}

export interface WorkPlanWorkspaceOption {
  readonly id: string;
  readonly title: string;
}

export interface ParsedWorkPlan {
  /** 解析出的标题。 */
  readonly title: string;
  /** 解析出的项目；调用者没有可见工作区时为 undefined。 */
  readonly workspaceId?: string | undefined;
  readonly workspaceTitle?: string | undefined;
  /** 产品展示口径优先级，固定落在 P0–P3。 */
  readonly priority: string;
  /** 截止日期（yyyy-mm-dd）。 */
  readonly due: string;
  readonly matchedWorkspace: boolean;
  readonly matchedPriority: boolean;
  readonly matchedDue: boolean;
}

export function parseWorkPlanInstruction(input: {
  readonly instruction: string;
  readonly workspaces: readonly WorkPlanWorkspaceOption[];
  readonly now?: Date | undefined;
}): ParsedWorkPlan {
  const instruction = String(input.instruction ?? "").trim();
  const now = input.now ?? new Date();
  const matchedWorkspace = input.workspaces.find((workspace) =>
    instruction.includes(workspace.title),
  );
  const fallbackWorkspace = input.workspaces[0];
  const workspace = matchedWorkspace ?? fallbackWorkspace;
  const priority = parseWorkPlanPriority(instruction);
  const due = parseWorkPlanDueDate(instruction, now);
  return {
    title: compactWorkPlanTitle(instruction),
    ...(workspace === undefined
      ? {}
      : { workspaceId: workspace.id, workspaceTitle: workspace.title }),
    priority: priority ?? "P2",
    due: due ?? addDays(now, 1),
    matchedWorkspace: matchedWorkspace !== undefined,
    matchedPriority: priority !== undefined,
    matchedDue: due !== undefined,
  };
}

/** 产品展示口径 P0–P3 → 任务模块存储口径 P1–P3。 */
export function taskPriorityForDisplay(priority: string): "P1" | "P2" | "P3" {
  if (priority === "P0") return "P1";
  if (priority === "P1") return "P2";
  if (priority === "P2") return "P3";
  if (priority === "P3") return "P3";
  return "P3";
}
