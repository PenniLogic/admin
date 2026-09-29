// @ts-check
/**
 * Runs ESLint in a separate process for the import-boundary tests, so the test worker never loads
 * eslint.config.mjs natively next to the instrumented policy module.
 *
 * Usage: node tests/support/eslint-mirror.mjs <repository-root>
 * stdin: {"configFiles": string[], "lint": [{"name": string, "filePath": string, "source": string}]}
 * stdout: {"configs": {[file]: rule config}, "results": {[name]: message[]}}
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import tseslint from "typescript-eslint";

const root = process.argv[2];
if (root === undefined) {
  throw new Error("Repository root argument is required.");
}
/** @type {{ configFiles: string[], lint: { name: string, filePath: string, source: string }[] }} */
const input = JSON.parse(readFileSync(0, "utf8"));
const eslint = new ESLint({ cwd: root });
/**
 * Virtual files are not part of the TypeScript project service, so they are linted with the same
 * configuration minus the type-aware rules; the mirror rules under test are all syntactic.
 */
const syntacticEslint = new ESLint({
  cwd: root,
  overrideConfig: [
    {
      files: ["**/*.{ts,tsx,mts,cts}"],
      ...tseslint.configs.disableTypeChecked,
    },
  ],
});

/** @type {Record<string, unknown>} */
const configs = {};
for (const file of input.configFiles) {
  const config = /** @type {{ rules?: Record<string, unknown> }} */ (await eslint.calculateConfigForFile(path.join(root, file)));
  configs[file] = config.rules?.["no-restricted-imports"] ?? null;
}

/** @type {Record<string, unknown>} */
const results = {};
for (const item of input.lint) {
  const [result] = await syntacticEslint.lintText(item.source, { filePath: path.join(root, item.filePath) });
  results[item.name] = (result?.messages ?? []).map((message) => ({
    ruleId: message.ruleId,
    severity: message.severity,
    message: message.message,
    fatal: message.fatal === true,
  }));
}

process.stdout.write(JSON.stringify({ configs, results }));
