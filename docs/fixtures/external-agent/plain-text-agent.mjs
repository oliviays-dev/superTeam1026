const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const prompt = chunks.join("").trim();
  process.stdout.write(
    `收到任务：${prompt || "(empty)"}\n\n外部 Agent 已完成本地验证。`,
  );
});
