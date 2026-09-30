#!/usr/bin/env bun
/**
 * postinstall: shim effect/unstable/* -> effect/dist/*
 *
 * @smithers-orchestrator/*@0.32.0 was compiled against effect@4.0.0-beta.102
 * which exposed `effect/unstable/<area>/<Module>`. Our override pins
 * effect to 4.0.0-rc.118 (required: split installs crash the engine with
 * "undefined is not an object (evaluating impl.base.get)" — see commit 1dd14b8),
 * where those modules moved to `effect/dist/<area>/<Module>.js` and the
 * unstable/ tree was removed from both the filesystem AND the package.json
 * exports map.
 *
 * Since effect's exports map is restrictive (no filesystem fallback for
 * unlisted subpaths), we patch the exports map to re-add the old paths
 * pointing at the new dist files. We scan the installed @smithers-orchestrator
 * dist for actual `effect/unstable/*` imports so the shim set stays exact.
 * Runs on every install. Idempotent.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const effectDir = join(root, "node_modules", "effect");
const effectPkgPath = join(effectDir, "package.json");
const smithersDir = join(root, "node_modules", "@smithers-orchestrator");

if (!existsSync(effectPkgPath)) {
  console.log("[postinstall] effect not installed, skipping shims");
  process.exit(0);
}

// Collect every effect/unstable/* import from the installed smithers dist.
const unstableImports = new Set<string>();
if (existsSync(smithersDir)) {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".js")) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/effect\/unstable\/([a-zA-Z0-9/_-]+)/g)) {
          unstableImports.add(m[1]);
        }
      }
    }
  };
  walk(smithersDir);
}

const pkg = JSON.parse(readFileSync(effectPkgPath, "utf8"));
pkg.exports = pkg.exports || {};

let patched = 0;
for (const sub of [...unstableImports].sort()) {
  const exportPath = `./unstable/${sub}`;
  // Try <sub>.js first, then <sub>/index.js (e.g. cluster -> dist/cluster/index.js)
  let target = `./dist/${sub}.js`;
  if (!existsSync(join(effectDir, target))) {
    target = `./dist/${sub}/index.js`;
  }
  const targetAbs = join(effectDir, target);
  if (!existsSync(targetAbs)) {
    console.warn(`[postinstall] skip ${exportPath}: target missing (${target})`);
    continue;
  }
  if (pkg.exports[exportPath] !== target) {
    pkg.exports[exportPath] = target;
    patched++;
  }
}

if (patched > 0) {
  writeFileSync(effectPkgPath, JSON.stringify(pkg, null, 2) + "\n");
}
console.log(`[postinstall] effect unstable/ exports shims: ${patched} patched (${unstableImports.size} imports found)`);
