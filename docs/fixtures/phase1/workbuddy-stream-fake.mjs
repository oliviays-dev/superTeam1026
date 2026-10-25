#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
  const prompt = chunks.join("");
  const args = process.argv.slice(2);
  const valueAfter = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] !== undefined
      ? args[index + 1]
      : fallback;
  };
  const scenario = valueAfter("--scenario", "search");
  const sessionId = valueAfter("--phase1-session", "phase1-workbuddy-fake");
  const slow = args.includes("--slow");
  const writeReport = args.includes("--write-report");
  const writeFile = args.includes("--write-file");
  const feedbackToken =
    prompt.match(/PHASE1_FEEDBACK_(?!SEEN(?:=|\b))[A-Z0-9_]+/)?.[0] ?? "NONE";
  const sourcePolicySeen =
    prompt.includes("## 来源策略") &&
    prompt.includes("public-web") &&
    prompt.includes("regulatory-filing");

  const pause = async (milliseconds) => {
    if (slow || milliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
  };
  const emit = (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };

  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "phase1-research-model",
    model_provider: "phase1-fixture",
    runtime_version: "1.0.0-phase1",
    auth_mode: "fixture-no-secret",
    sandbox: "workspace-write",
    cwd: process.cwd(),
  });
  await pause(slow ? 300 : 0);

  emit({
    type: "assistant",
    session_id: sessionId,
    message: {
      content: [
        {
          type: "thinking",
          thinking: "PHASE1_VISIBLE_REASONING_SUMMARY_ONLY",
        },
      ],
    },
  });
  emit({
    type: "assistant",
    session_id: sessionId,
    message: {
      content: [
        {
          type: "text",
          text: "PHASE1_VISIBLE_PROGRESS：正在核对竞品范围与来源。",
        },
      ],
    },
  });
  await pause(slow ? 900 : 50);

  if (scenario === "search") {
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-search-1",
            name: "web_search",
            input: {
              query: "2026 match-3 mobile game market competitors",
            },
          },
        ],
      },
    });
    await pause(slow ? 900 : 50);
    emit({
      type: "user",
      session_id: sessionId,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-search-1",
            is_error: false,
            content:
              "PHASE1_SEARCH_RESULT：已找到公开竞品资料，来源、发布日期和访问时间均可记录。",
          },
        ],
      },
    });
  }

  if (scenario === "write") {
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-write-1",
            name: "write",
            input: {
              path: "phase1-external-write.txt",
              content: "PHASE1_EXTERNAL_WRITE_OBSERVED",
            },
          },
        ],
      },
    });
    await pause(slow ? 900 : 50);
    emit({
      type: "user",
      session_id: sessionId,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-write-1",
            is_error: false,
            content: "PHASE1_EXTERNAL_WRITE_OBSERVED",
          },
        ],
      },
    });
  }

  if (scenario === "cancel") {
    await pause(60_000);
  }

  if (scenario === "fail") {
    emit({
      type: "result",
      subtype: "error",
      session_id: sessionId,
      is_error: true,
      result: "PHASE1_EXPECTED_FAILURE：外部 Runtime 模拟失败。",
    });
    return;
  }

  const lines = [
    `\`${
      scenario === "write"
        ? "PHASE1_EXTERNAL_WRITE_DONE"
        : "PHASE1_RESEARCH_DONE"
    }\``,
    `\`PHASE1_SESSION=${sessionId}\``,
    `\`PHASE1_SOURCE_POLICY_SEEN=${sourcePolicySeen ? "YES" : "NO"}\``,
    `\`PHASE1_FEEDBACK_SEEN=${feedbackToken}\``,
    "`SOURCE_URL=https://example.com/phase1-public-market-report`",
    "`PUBLISHED_AT=2026-09-30`",
    "`ACCESSED_AT=2026-10-25`",
  ];
  if (writeReport) {
    const reportName =
      feedbackToken === "NONE"
        ? "phase1-market-research-report.md"
        : "phase1-market-research-report-feedback.md";
    writeFileSync(
      reportName,
      [
        "# PHASE1 Match-3 Market Research",
        "",
        ...lines.map((line) => `- ${line}`),
        "",
        "## Findings",
        "",
        "This deterministic fixture output validates downstream document registration.",
      ].join("\n"),
    );
  }
  if (scenario === "write" && writeFile) {
    writeFileSync(
      "phase1-external-write.txt",
      "PHASE1_EXTERNAL_WRITE_OBSERVED",
    );
  }
  emit({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    result: lines.join("\n"),
  });
});
