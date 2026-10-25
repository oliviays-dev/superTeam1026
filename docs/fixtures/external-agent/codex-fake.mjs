import { writeFileSync } from "node:fs";

const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  process.stdout.write(
    `${JSON.stringify({
      type: "progress",
      text: "外部 Agent 正在执行",
      thread_id: "gui-fake-thread-1",
    })}\n`,
  );
  const outputIndex = process.argv.indexOf("--output-last-message");
  if (outputIndex >= 0) {
    const outputFile = process.argv[outputIndex + 1];
    writeFileSync(
      outputFile,
      "# 交付报告\n\n## 交付说明\n\nCodex 假实现已完成 GUI 验收任务，且满足最少字数要求。",
    );
  }
});
