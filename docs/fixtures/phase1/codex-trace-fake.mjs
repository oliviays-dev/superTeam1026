#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
  const prompt = chunks.join("");
  const feedbackToken =
    prompt.match(/PHASE1_FEEDBACK_(?!SEEN(?:=|\b))[A-Z0-9_]+/)?.[0] ?? "NONE";
  const sessionId = "phase1-codex-fake-thread";
  const emit = (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 250));

  emit({ type: "thread.started", thread_id: sessionId });
  emit({
    type: "item.completed",
    item: {
      type: "reasoning",
      text: "PHASE1_CODEX_REASONING_SUMMARY_ONLY",
    },
  });
  await pause();
  emit({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "rg PHASE1 docs/fixtures/phase1",
      aggregated_output: "发现阶段一测试说明与 fake runtime",
      status: "completed",
    },
  });
  await pause();
  emit({
    type: "item.completed",
    item: {
      type: "file_change",
      changes: [
        {
          path: "outputs/phase1-codex-trace-report.md",
          kind: "add",
        },
      ],
    },
  });
  emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "PHASE1_CODEX_VISIBLE_PROGRESS",
    },
  });

  const outputIndex = process.argv.indexOf("--output-last-message");
  if (outputIndex >= 0 && process.argv[outputIndex + 1] !== undefined) {
    writeFileSync(
      process.argv[outputIndex + 1],
      [
        "# Phase 1 Codex Trace Report",
        "",
        "`PHASE1_CODEX_DONE`",
        `\`PHASE1_FEEDBACK_SEEN=${feedbackToken}\``,
        "",
        "这是用于验证 Codex JSONL 进度、工具事件与最终消息映射的测试产物。",
      ].join("\n"),
    );
  }
});
