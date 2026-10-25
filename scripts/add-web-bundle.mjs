import { readFileSync, writeFileSync } from "node:fs";

const manifestPath = process.argv[2];
if (manifestPath === undefined) {
  console.error("usage: node add-web-bundle.mjs <profile-manifest>");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const current = manifest.dsh?.profile?.bundles ?? [];
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  ...current.filter(
    (bundle) =>
      bundle !== "@deepseek-ai/dsh-base" &&
      bundle !== "@deepseek-ai/dsh-web-app",
  ),
];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
