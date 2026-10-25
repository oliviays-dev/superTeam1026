#!/usr/bin/env node
/**
 * 一次性清理：合并会议里「同 owner + 同基础名」的重复 agent 参与者。
 *
 * 背景：`spawnAgentForUser` 早前每次 dispatch 都会新建一条 agent 参与者，
 * 重名时被 `uniqueAgentName` 改写成「名字 · owner」，于是同一场会议里会出现
 * 两条看起来一样的 agent（例如 `江问01 产品` 与 `江问01 产品 · 平台Admin`）。
 * 幂等 spawn 已经堵住新增；这个脚本负责把历史数据清干净。
 *
 * 用法（必须在 DSH 进程停止时执行，否则内存态会覆盖磁盘）：
 *   node scripts/cleanup-meeting-duplicate-agents.mjs            # dry-run，只打印
 *   node scripts/cleanup-meeting-duplicate-agents.mjs --apply    # 落盘（先备份）
 *
 * 处理方式：同组只保留一条 active（优先保留未被改名的，其次
 * ai_teammate > ai_representative > agent，最后看最早入会），
 * 其余按「离会」打墓碑（status=left + leftAt），与正常移除参与者一致，
 * 历史消息仍可追溯到它们，不会留下悬空引用。
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const home = process.env.DSH_HOME ?? join(root, ".tmp/dsh-home");
const file = join(home, "storages/collab_meeting.json");
const apply = process.argv.includes("--apply");

const baseNameOf = (displayName) =>
  String(displayName ?? "").split(" · ")[0].trim();

const store = JSON.parse(readFileSync(file, "utf8"));
const participants = store.tables.participants ?? {};
const groups = new Map();

/** 会里的 AI 参与者：普通 AI 成员、参会代表、被 spawn 的会议 Agent。 */
const AI_KINDS = new Set(["ai_teammate", "ai_representative", "agent"]);
/** 保留优先级：常驻 AI 成员 > 参会代表 > 临时 spawn 的会议 Agent。 */
const KIND_RANK = { ai_teammate: 0, ai_representative: 1, agent: 2 };

for (const participant of Object.values(participants)) {
  if (!AI_KINDS.has(participant.kind) || participant.status !== "active")
    continue;
  const base = baseNameOf(participant.displayName);
  if (base === "") continue;
  // 只按「会议 + 基础名」分组：历史数据里 ownerId 常为空，
  // 而重名去重本身就是按名字判定的（uniqueAgentName 也是看 displayName）。
  const key = [participant.meetingId, base].join("::");
  const bucket = groups.get(key) ?? [];
  bucket.push(participant);
  groups.set(key, bucket);
}

const now = new Date().toISOString();
const tombstoned = [];
for (const bucket of groups.values()) {
  if (bucket.length < 2) continue;
  const sorted = [...bucket].sort((left, right) => {
    const leftRenamed = left.displayName.includes(" · ") ? 1 : 0;
    const rightRenamed = right.displayName.includes(" · ") ? 1 : 0;
    if (leftRenamed !== rightRenamed) return leftRenamed - rightRenamed;
    const rank =
      (KIND_RANK[left.kind] ?? 9) - (KIND_RANK[right.kind] ?? 9);
    if (rank !== 0) return rank;
    return String(left.joinedAt ?? "").localeCompare(
      String(right.joinedAt ?? ""),
    );
  });
  const [keep, ...duplicates] = sorted;
  for (const duplicate of duplicates) {
    tombstoned.push({
      id: duplicate.id,
      meetingId: duplicate.meetingId,
      displayName: duplicate.displayName,
      kept: keep.displayName,
    });
    if (apply) {
      participants[duplicate.id] = {
        ...duplicate,
        status: "left",
        leftAt: now,
        updatedAt: now,
      };
    }
  }
}

console.log(`文件：${file}`);
console.log(`重复组：${[...groups.values()].filter((b) => b.length > 1).length}`);
console.log(`待合并（打墓碑）参与者：${tombstoned.length}`);
for (const item of tombstoned) {
  console.log(
    `  - ${item.meetingId.slice(0, 8)}… 「${item.displayName}」 → 合并到「${item.kept}」`,
  );
}

if (tombstoned.length === 0) {
  console.log("没有需要处理的重复参与者。");
  process.exit(0);
}
if (!apply) {
  console.log("\n[dry-run] 未写入。确认无误后加 --apply 落盘。");
  process.exit(0);
}

const backup = `${file}.bak-dup-${Date.now()}`;
copyFileSync(file, backup);
writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
console.log(`\n已写入。备份：${backup}`);
