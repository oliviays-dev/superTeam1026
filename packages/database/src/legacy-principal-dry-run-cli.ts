import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import {
  buildPrincipalDryRunReport,
  writePrincipalDryRunReports,
} from "./legacy-principal-dry-run.js";
import { readLegacyPrincipalSnapshot } from "./legacy-principal-snapshot.js";

interface CliOptions {
  readonly sourceHome: string;
  readonly output: string;
  readonly asOf: string;
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm migration:principal-dry-run --source-home <absolute .tmp snapshot> \\",
    "    --output <absolute .tmp/report.json> --as-of <UTC timestamp>",
  ].join("\n");
}

function optionValue(
  argv: readonly string[],
  name: string,
): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function parseOptions(argv: readonly string[]): CliOptions {
  const sourceHome = optionValue(argv, "--source-home");
  const output = optionValue(argv, "--output");
  const asOf = optionValue(argv, "--as-of");
  if (
    sourceHome === undefined ||
    output === undefined ||
    asOf === undefined ||
    sourceHome.startsWith("--") ||
    output.startsWith("--") ||
    asOf.startsWith("--")
  ) {
    throw new Error(usage());
  }
  if (!isAbsolute(sourceHome) || !isAbsolute(output)) {
    throw new Error("Both --source-home and --output must be absolute paths.");
  }
  if (!asOf.endsWith("Z") || !Number.isFinite(Date.parse(asOf))) {
    throw new Error("--as-of must be an RFC 3339 UTC timestamp ending in Z.");
  }
  return { sourceHome, output, asOf };
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value !== "" && !value.startsWith("..") && !isAbsolute(value);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  const tempRoot = resolve(process.cwd(), ".tmp");
  const sourceHome = await realpath(options.sourceHome);
  if (!isWithin(tempRoot, sourceHome)) {
    throw new Error(
      "--source-home must be an explicit read-only snapshot inside this worktree's .tmp directory.",
    );
  }
  if (!isWithin(tempRoot, resolve(options.output))) {
    throw new Error("--output must be inside this worktree's .tmp directory.");
  }
  if (!options.output.endsWith(".json")) {
    throw new Error("--output must use the .json extension.");
  }

  const snapshot = await readLegacyPrincipalSnapshot({ sourceHome });
  const report = buildPrincipalDryRunReport({
    snapshot,
    asOf: new Date(options.asOf).toISOString(),
  });
  const paths = await writePrincipalDryRunReports({
    report,
    jsonPath: resolve(options.output),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "dry-run",
        sourceDigest: report.sourceDigest,
        readyToBackfill: report.readyToBackfill,
        conflicts: report.conflicts.length,
        orphans: report.orphans.length,
        blocked: report.blocked.length,
        jsonReport: paths.jsonPath,
        markdownSummary: paths.markdownPath,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "dry-run failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
