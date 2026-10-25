#!/usr/bin/env node
/**
 * 一次性清理：删除历史遗留的「会议纪要待确认」任务记录（`meeting_tasks.kind = minutes_confirm`）。
 *
 * 背景：纪要改成「以最近更新为准、无需人工确认」之后，前端不再有确认入口，
 * 这类待确认记录只会一直挂着；服务端也已停止创建新的。
 *
 * 用法（必须在 DSH 进程停止时执行，否则内存态会覆盖磁盘）：
 *   node scripts/cleanup-meeting-minutes-confirm.mjs            # dry-run，只打印
 *   node scripts/cleanup-meeting-minutes-confirm.mjs --apply    # 落盘（先备份）
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const home = process.env.DSH_HOME ?? join(root, ".tmp/dsh-home");
const file = join(home, "storages/collab_meeting.json");
const apply = process.argv.includes("--apply");

const store = JSON.parse(readFileSync(file, "utf8"));
const tasks = store.tables.meeting_tasks ?? {};
const stale = Object.entries(tasks).filter(
  ([, task]) => task.kind === "minutes_confirm",
);

console.log(`文件：${file}`);
console.log(`待清理记录：${stale.length}`);
for (const [key, task] of stale) {
  console.log(
    `  - ${key.slice(0, 8)}… meeting=${String(task.meetingId).slice(0, 8)}… status=${task.status}`,
  );
}

if (stale.length === 0) {
  console.log("没有需要清理的记录。");
  process.exit(0);
}
if (!apply) {
  console.log("\n[dry-run] 未写入。确认无误后加 --apply 落盘。");
  process.exit(0);
}

for (const [key] of stale) delete tasks[key];
const backup = `${file}.bak-minutes-confirm-${Date.now()}`;
copyFileSync(file, backup);
writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
console.log(`\n已写入 ${stale.length} 条。备份：${backup}`);
