import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const mode = args[0];
const scenario = args[1];

async function readPrompt() {
  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  const parts = [];
  for await (const line of lines) parts.push(line);
  return parts.join("\n");
}

function json(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function holdUntilTerminated({ stubborn = false } = {}) {
  if (stubborn) {
    process.on("SIGTERM", () => {
      process.stderr.write("ignoring SIGTERM\n");
    });
  }
  setInterval(() => undefined, 1_000);
}

function writeCodexSession() {
  json({
    type: "session_meta",
    payload: {
      session_id: "codex-session-fixture",
      model_provider: "openai-fixture",
      cli_version: "9.8.7-fixture",
      auth_mode: "chatgpt",
    },
  });
  json({
    type: "turn_context",
    payload: {
      model: "gpt-fixture",
      sandbox_policy: { type: "read-only" },
      permission_profile: { network: "restricted" },
    },
  });
}

async function runCodex() {
  if (scenario === "cancel") {
    json({ type: "thread.started", thread_id: "codex-session-cancel" });
    holdUntilTerminated();
    return;
  }
  if (scenario === "timeout") {
    holdUntilTerminated();
    return;
  }
  if (scenario === "stubborn") {
    holdUntilTerminated({ stubborn: true });
    return;
  }
  if (scenario === "bad-json") {
    json({ type: "thread.started", thread_id: "codex-session-bad-json" });
    process.stdout.write("{not-json\n");
    return;
  }
  if (scenario === "empty") {
    writeCodexSession();
    json({ type: "turn.started" });
    json({ type: "turn.completed", usage: { output_tokens: 0 } });
    return;
  }
  if (scenario === "fail") {
    process.stderr.write("codex fixture failed\n");
    process.exitCode = 7;
    return;
  }
  if (scenario === "signal") {
    process.kill(process.pid, "SIGTERM");
    return;
  }

  const prompt = await readPrompt();
  writeCodexSession();
  json({ type: "thread.started", thread_id: "codex-session-fixture" });
  json({ type: "turn.started" });
  json({
    type: "item.completed",
    item: {
      type: "reasoning",
      text: "PRIVATE_REASONING_MUST_NOT_LEAK",
    },
  });
  json({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: `Intermediate answer for ${prompt.length} characters`,
    },
  });
  json({
    type: "item.started",
    item: {
      type: "command_execution",
      command: "printf fixture-tool",
    },
  });
  json({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "printf fixture-tool",
      aggregated_output: "fixture-tool output",
      exit_code: 0,
    },
  });
  if (scenario === "warning") {
    json({ type: "warning", message: "fixture warning from provider" });
  }
  if (scenario === "error-event") {
    json({ type: "error", message: "fixture provider error" });
  }
  json({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: `FINAL:${prompt}`,
    },
  });
  json({ type: "turn.completed", usage: { output_tokens: 42 } });
}

async function runPlain() {
  if (scenario === "argv-and-stdin") {
    const prompt = await readPrompt();
    process.stdout.write(
      JSON.stringify({
        args: args.slice(2),
        prompt,
      }),
    );
    return;
  }
  if (scenario === "stdin-base64") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    process.stdout.write(Buffer.concat(chunks).toString("base64"));
    return;
  }
  if (scenario === "cancel") {
    holdUntilTerminated();
    return;
  }
  if (scenario === "timeout") {
    holdUntilTerminated();
    return;
  }
  if (scenario === "stubborn") {
    holdUntilTerminated({ stubborn: true });
    return;
  }
  if (scenario === "stubborn-tree") {
    const child = spawn(
      process.execPath,
      [process.argv[1], "orphan-stubborn"],
      {
        stdio: "ignore",
      },
    );
    writeFileSync(args[2], String(child.pid));
    holdUntilTerminated({ stubborn: true });
    return;
  }
  if (scenario === "empty") return;
  if (scenario === "stderr") {
    process.stderr.write("plain fixture diagnostic\n");
    process.stdout.write("plain output with diagnostic\n");
    return;
  }
  if (scenario === "fail") {
    process.stderr.write("plain fixture failed\n");
    process.exitCode = 4;
    return;
  }
  if (scenario === "signal") {
    process.kill(process.pid, "SIGTERM");
    return;
  }
  const prompt = await readPrompt();
  process.stdout.write(`PLAIN:${prompt}`);
}

if (mode === "orphan-stubborn") {
  holdUntilTerminated({ stubborn: true });
} else if (mode === "codex") {
  await runCodex();
} else if (mode === "plain") {
  await runPlain();
} else if (mode === "stdout-large") {
  process.stdout.write("x".repeat(Number(scenario ?? 4_096)));
} else if (mode === "echo-argv") {
  process.stdout.write(JSON.stringify({ argv: args }));
} else {
  process.stderr.write(`unknown fixture mode: ${String(mode)}\n`);
  process.exitCode = 2;
}
