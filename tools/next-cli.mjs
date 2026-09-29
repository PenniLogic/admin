// @ts-check
/**
 * Runs the Next.js CLI with telemetry disabled for every invocation.
 *
 * The scaffold ships build and test metrics only; no runtime or build telemetry leaves the
 * machine. The wrapper avoids a shell-specific environment assignment in package.json.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Located by path rather than through a resolver so no indirect module loader exists in this tree.
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

const result = spawnSync(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
