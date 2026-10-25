import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const expectedCommit = "d347e703908d0406b7a7ef80e3a0e594d86b2215";
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

check(
  git(["-C", "vendor/deepseek-harness", "rev-parse", "HEAD"]) ===
    expectedCommit,
  "upstream submodule must stay on the R0 baseline commit",
);
check(
  git(["-C", "vendor/deepseek-harness", "status", "--porcelain"]) === "",
  "upstream submodule working tree must remain clean",
);
const gitlink = git(["ls-files", "--stage", "vendor/deepseek-harness"]).split(
  /\s+/,
)[1];
check(
  gitlink === expectedCommit,
  "upstream gitlink must match the reviewed baseline commit",
);

const pluginRoot = join(root, "plugins");
const pluginNames = existsSync(pluginRoot)
  ? readdirSync(pluginRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : [];
check(pluginNames.length > 0, "at least one plugin package must exist");

for (const pluginName of pluginNames) {
  const dir = join(pluginRoot, pluginName);
  const manifestPath = join(dir, "package.json");
  const patchPath = join(dir, "cordis.patch.yml");
  check(existsSync(manifestPath), `${pluginName}: package.json is required`);
  check(existsSync(patchPath), `${pluginName}: cordis.patch.yml is required`);
  check(
    existsSync(join(dir, "lib/index.js")),
    `${pluginName}: built lib/index.js is required`,
  );
  check(
    existsSync(join(dir, "lib/client.js")),
    `${pluginName}: built lib/client.js is required`,
  );
  const clientSourcePath = join(dir, "client/index.js");
  if (existsSync(clientSourcePath)) {
    const clientSource = readFileSync(clientSourcePath, "utf8");
    check(
      /exports\.inject\s*=\s*\["slots"(?:\s*,\s*"[^"]+")*\]/.test(
        clientSource,
      ),
      `${pluginName}: client must declare its slots service dependency`,
    );
    const validSlots = [
      "root",
      "sidebar",
      "conversation.view",
      "settings.section",
      "pluginmax.account-access.tab",
      "sidebar.footer.action",
      "shell.overlay",
      "pluginmax.global",
    ];
    const replacesRoot = /ctx\.slots\.register\(\s*\{\s*name:\s*"root"/.test(
      clientSource,
    );
    check(
      replacesRoot ||
        validSlots.some((slot) =>
          new RegExp(`ctx\\.slots\\.inject\\(\\s*"${slot}"`).test(clientSource),
        ),
      `${pluginName}: client must register through a known DSH slot (${validSlots.join(", ")})`,
    );
    check(
      !clientSource.includes("ctx.inject("),
      `${pluginName}: client must not return slot registration from a nested context inject`,
    );
    check(
      readFileSync(join(dir, "lib/client.js"), "utf8") === clientSource,
      `${pluginName}: built client bundle must match client/index.js`,
    );
  }

  const serverSourcePath = join(dir, "src/index.ts");
  if (existsSync(serverSourcePath)) {
    const serverSource = readFileSync(serverSourcePath, "utf8");
    const toolRegistrations =
      serverSource.match(/ctx\.tools\.register\(/g)?.length ?? 0;
    const outputDeclarations =
      serverSource.match(/(^|\s)output:\s*/g)?.length ?? 0;
    check(
      outputDeclarations >= toolRegistrations,
      `${pluginName}: every tool registration must declare an output contract`,
    );
  }

  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  check(manifest.type === "module", `${pluginName}: package must be ESM`);
  check(
    manifest.exports?.["."] !== undefined,
    `${pluginName}: root export is required`,
  );
  check(
    manifest.exports?.["./client"] === "./lib/client.js",
    `${pluginName}: ./client export must point to lib/client.js`,
  );
  check(
    manifest.dsh?.bundle?.patch === "./cordis.patch.yml",
    `${pluginName}: dsh.bundle.patch declaration is required`,
  );
  check(
    manifest.dsh?.client?.platform === "web",
    `${pluginName}: web dsh.client declaration is required`,
  );
  check(
    manifest.files?.includes("lib/**/*"),
    `${pluginName}: package files must include lib/**/*`,
  );

  if (existsSync(patchPath)) {
    const patch = readFileSync(patchPath, "utf8");
    check(
      patch.includes("insert:"),
      `${pluginName}: patch must insert a plugin row`,
    );
    check(
      patch.includes(`name: ${manifest.name}`),
      `${pluginName}: patch must reference ${manifest.name}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`contract failures (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `contract passed: ${pluginNames.length} plugin bundle(s), upstream ${expectedCommit.slice(0, 7)}`,
  );
}
