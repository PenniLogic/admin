// @ts-check
/**
 * Command-line entry: `node tools/import-boundary/check.mjs [--root <dir>]`.
 * Exits 1 when any import, dependency or lockfile entry violates the admin import boundary.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanRepository } from "./scan.mjs";

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
const rootIndex = process.argv.indexOf("--root");
const root = rootIndex === -1 ? repositoryRoot : (process.argv[rootIndex + 1] ?? repositoryRoot);

const result = scanRepository(root);
for (const violation of result.violations) {
  const location = violation.line === undefined ? violation.file : `${violation.file}:${String(violation.line)}`;
  console.error(`${violation.rule}: ${location} -> ${violation.specifier} (${violation.message})`);
}
if (result.violations.length > 0) {
  console.error(`Import boundary violated: ${String(result.violations.length)} finding(s) in ${result.root}`);
  process.exit(1);
}
console.log(`Import boundary intact: ${String(result.files.length)} source files, manifest, lockfile and configuration checked.`);
