import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  ALLOWED_ORGANIZATION_PACKAGES,
  LOADER_BUILTIN_ALLOWANCES,
  NEXT_CONFIG_ALLOWED_KEYS,
  NEXT_CONFIG_SIBLINGS,
  organizationRuleFor,
  packageNameOf,
  RESTRICTED_IMPORT_PATHS,
  RESTRICTED_IMPORT_PATTERNS,
  RESTRICTED_LOADER_BUILTIN_PATHS,
  RULES,
  RUNTIME_ALLOWED_SPECIFIERS,
  RUNTIME_REFUSED_IDENTIFIERS,
  RUNTIME_RESTRICTED_GLOBALS,
  RUNTIME_RESTRICTED_IMPORT_PATTERNS,
  TSCONFIG_PINNED_PATHS,
} from "@/tools/import-boundary/policy.mjs";
import {
  canonical,
  checkLockfile,
  checkManifest,
  checkNextConfig,
  checkNextConfigFiles,
  checkSource,
  checkSpecifier,
  checkTsconfig,
  declaredDependencies,
  extractSpecifiers,
  IGNORED_DIRECTORIES,
  isRuntimeAllowedSpecifier,
  isRuntimeFile,
  listSourceFiles,
  parseSource,
  scanRepository,
  SOURCE_EXTENSIONS,
} from "@/tools/import-boundary/scan.mjs";
import vitestConfig from "@/vitest.config.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "import-boundary");
const CHECK_CLI = path.join(ROOT, "tools", "import-boundary", "check.mjs");
const COPIED_INTO_PLANTED_ROOTS = ["package.json", "package-lock.json", "tsconfig.json", "next.config.ts"];
const RUNTIME_PLANT = path.join(ROOT, "src", "planted.ts");
const TOOL_PLANT = path.join(ROOT, "tools", "planted.mjs");

type Manifest = Parameters<typeof checkManifest>[0];
type Lockfile = Parameters<typeof checkLockfile>[0];

const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as Manifest;
const lockfile = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as Lockfile;
const tsconfig = JSON.parse(readFileSync(path.join(ROOT, "tsconfig.json"), "utf8")) as Record<string, unknown>;
const nextConfigSource = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
const context = { root: ROOT, declared: declaredDependencies(manifest) };

/**
 * Planted sources live in .txt fixtures, never inline in a scanned source file, and each names the
 * rule it must trip when planted as a runtime file (src/planted.ts). The two clean controls must pass.
 */
const PLANTED: Record<string, string> = {
  "customer-web-package.txt": RULES.organizationPackage,
  "customer-web-type-import.txt": RULES.organizationPackage,
  "shared-client-bundle.txt": RULES.customerCode,
  "customer-web-literal.txt": RULES.customerCode,
  "unscoped-prefix.txt": RULES.organizationPackage,
  "dynamic-import.txt": RULES.organizationPackage,
  "require-call.txt": RULES.organizationPackage,
  "import-equals-require.txt": RULES.organizationPackage,
  "import-type-node.txt": RULES.organizationPackage,
  "template-dynamic-import.txt": RULES.nonLiteralSpecifier,
  "variable-require.txt": RULES.nonLiteralSpecifier,
  "concatenated-dynamic-import.txt": RULES.nonLiteralSpecifier,
  "concatenated-require.txt": RULES.nonLiteralSpecifier,
  "trimmed-require.txt": RULES.nonLiteralSpecifier,
  "two-argument-dynamic-import.txt": RULES.nonLiteralSpecifier,
  "create-require.txt": RULES.indirectLoader,
  "module-create-require.txt": RULES.indirectLoader,
  "eval-loader.txt": RULES.indirectLoader,
  "function-constructor.txt": RULES.indirectLoader,
  "function-via-constructor.txt": RULES.indirectLoader,
  "require-resolve.txt": RULES.indirectLoader,
  "import-meta-resolve.txt": RULES.indirectLoader,
  "aliased-require.txt": RULES.indirectLoader,
  "module-require-member.txt": RULES.indirectLoader,
  "require-main-require.txt": RULES.indirectLoader,
  "literal-key-module-binding.txt": RULES.indirectLoader,
  "vm-loader.txt": RULES.indirectLoader,
  "worker-threads-loader.txt": RULES.indirectLoader,
  "child-process-loader.txt": RULES.indirectLoader,
  "s7-getbuiltinmodule-proxy.txt": RULES.indirectLoader,
  "computed-process-member.txt": RULES.computedAccess,
  "computed-module-binding.txt": RULES.computedAccess,
  "computed-globalthis.txt": RULES.computedAccess,
  "parenthesized-import-meta.txt": RULES.indirectLoader,
  "relative-escape.txt": RULES.escapesRepository,
  "deep-relative-escape.txt": RULES.escapesRepository,
  "alias-escape.txt": RULES.escapesRepository,
  "alias-percent-encoded.txt": RULES.escapesRepository,
  "triple-slash-reference.txt": RULES.escapesRepository,
  "package-subpath-escape.txt": RULES.escapesRepository,
  "package-subpath-dot.txt": RULES.escapesRepository,
  "absolute-path.txt": RULES.absoluteOrRemote,
  "remote-url.txt": RULES.absoluteOrRemote,
  "subpath-import.txt": RULES.absoluteOrRemote,
  "undeclared-package.txt": RULES.undeclaredDependency,
  "node-scheme-non-builtin.txt": RULES.undeclaredDependency,
  "runtime-node-builtin.txt": RULES.runtimeImport,
  "runtime-dev-package.txt": RULES.runtimeImport,
  "runtime-next-value-import.txt": RULES.runtimeImport,
  "runtime-next-default-import.txt": RULES.runtimeImport,
  "runtime-next-mixed-import.txt": RULES.runtimeImport,
  "runtime-next-reexport.txt": RULES.runtimeImport,
  "runtime-next-dist-type.txt": RULES.runtimeImport,
  "runtime-next-compiled.txt": RULES.runtimeImport,
  "runtime-react-import.txt": RULES.runtimeImport,
  "runtime-react-dom-server.txt": RULES.runtimeImport,
  "s9-evalmanifest-proxy.txt": RULES.runtimeImport,
  "s9-requirepage-proxy.txt": RULES.runtimeImport,
  "runtime-fetch.txt": RULES.runtimeReference,
  "runtime-timer.txt": RULES.runtimeReference,
  "runtime-globalthis.txt": RULES.runtimeReference,
  "runtime-this.txt": RULES.runtimeReference,
  "runtime-computed-destructuring.txt": RULES.computedAccess,
  "reflect-get-process.txt": RULES.indirectLoader,
};
/** A comment inside the call does not hide a literal specifier; the package rule still applies. */
const PLANTED_WITH_COMMENT = { "commented-dynamic-import.txt": RULES.organizationPackage };
const CONTROLS = ["clean-source.txt", "clean-module.txt"];
/** Clean when planted as runtime source: type-only next imports, literal computed keys, `@/` files. */
const RUNTIME_CONTROLS = ["clean-runtime-types.txt"];
/** Fixtures that are clean everywhere except in runtime source, where the positive allowlist applies. */
const RUNTIME_ONLY = [
  "runtime-node-builtin.txt",
  "runtime-dev-package.txt",
  "runtime-next-value-import.txt",
  "runtime-next-default-import.txt",
  "runtime-next-mixed-import.txt",
  "runtime-next-reexport.txt",
  "runtime-next-dist-type.txt",
  "runtime-next-compiled.txt",
  "runtime-react-import.txt",
  "runtime-react-dom-server.txt",
  "s9-evalmanifest-proxy.txt",
  "s9-requirepage-proxy.txt",
  "runtime-fetch.txt",
  "runtime-timer.txt",
  "runtime-globalthis.txt",
  "runtime-this.txt",
  "runtime-computed-destructuring.txt",
];

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

/** Copies the manifest, lockfile and configuration into a throwaway root so a planted file can be scanned end to end. */
function plantedRepository(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "admin-import-boundary-"));
  for (const name of COPIED_INTO_PLANTED_ROOTS) {
    cpSync(path.join(ROOT, name), path.join(root, name));
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function withPlantedRepository(files: Record<string, string>, run: (root: string) => void): void {
  const root = plantedRepository(files);
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Creates a directory link (junction on Windows) or returns false when the platform refuses. */
function tryLinkDirectory(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("import boundary of the real repository", () => {
  it("finds no violation in the manifest, lockfile, configuration or any source file", () => {
    const result = scanRepository(ROOT);
    expect(result.violations).toEqual([]);
    expect(result.files).toContain("proxy.ts");
    expect(result.files).toContain(path.join("app", "[[...path]]", "route.ts"));
    expect(result.files).toContain(path.join("src", "boundary", "authorize.ts"));
    expect(result.files).toContain(path.join("tools", "import-boundary", "scan.mjs"));
    expect(result.files).toContain(path.join("tests", "unit", "import-boundary.test.ts"));
    expect(result.files.some((file) => file.startsWith("node_modules"))).toBe(false);
    expect(result.files.some((file) => file.startsWith(".next"))).toBe(false);
  });

  it("declares no organization package and every dependency exactly from the registry", () => {
    expect(ALLOWED_ORGANIZATION_PACKAGES).toEqual([]);
    expect(checkManifest(manifest)).toEqual([]);
    expect(checkLockfile(lockfile, manifest)).toEqual([]);
    for (const name of context.declared) {
      expect(organizationRuleFor(name), name).toBeNull();
    }
  });

  it("pins the compiler, bundler and test-runner resolution surfaces", () => {
    expect(checkTsconfig(tsconfig)).toEqual([]);
    expect(checkNextConfig(nextConfigSource)).toEqual([]);
    expect(checkNextConfigFiles(ROOT)).toEqual([]);
    expect(TSCONFIG_PINNED_PATHS).toEqual({ "@/*": ["./*"] });
    const alias = vitestConfig.resolve?.alias as readonly { find: RegExp | string; replacement: string }[] | undefined;
    expect(alias).toHaveLength(1);
    expect(alias?.[0]?.find).toEqual(/^@\//);
    expect(path.resolve(alias?.[0]?.replacement ?? "")).toBe(ROOT);
    expect(vitestConfig.resolve?.preserveSymlinks).toBeUndefined();
    expect(vitestConfig.server).toBeUndefined();
  });

  it("classifies the runtime source set and keeps it on the exact type-only allowlist", () => {
    for (const file of ["proxy.ts", "next.config.ts", "app/[[...path]]/route.ts", "src/boundary/denial.ts", "src/deep/x.tsx"]) {
      expect(isRuntimeFile(ROOT, path.join(ROOT, file)), file).toBe(true);
    }
    for (const file of ["tools/next-cli.mjs", "tests/unit/proxy.test.ts", "eslint.config.mjs", "vitest.config.mts", "srcfile.ts", "apps/x.ts"]) {
      expect(isRuntimeFile(ROOT, path.join(ROOT, file)), file).toBe(false);
    }
    expect(RUNTIME_ALLOWED_SPECIFIERS).toEqual({ "next/server": { typeOnly: true }, next: { typeOnly: true } });
    for (const specifier of ["@/proxy", "@/src/boundary/denial"]) {
      expect(isRuntimeAllowedSpecifier(specifier), specifier).toBe(true);
      expect(isRuntimeAllowedSpecifier(specifier, true), specifier).toBe(true);
    }
    for (const specifier of ["next", "next/server"]) {
      expect(isRuntimeAllowedSpecifier(specifier, true), `${specifier} as types`).toBe(true);
      expect(isRuntimeAllowedSpecifier(specifier), `${specifier} as values`).toBe(false);
      expect(isRuntimeAllowedSpecifier(specifier, false), `${specifier} as values`).toBe(false);
    }
    const refused = [
      "next/dist/server/require",
      "next/dist/server/load-manifest.external",
      "next/dist/compiled/ws",
      "next/navigation",
      "next/headers",
      "react",
      "react-dom",
      "react-dom/server",
      "node:fs",
      "fs",
      "typescript",
      "nextjs",
      "eslint",
      "./denial",
      "../boundary/authorize",
      "hasOwnProperty",
      "constructor",
    ];
    for (const specifier of refused) {
      expect(isRuntimeAllowedSpecifier(specifier, true), specifier).toBe(false);
      expect(isRuntimeAllowedSpecifier(specifier), specifier).toBe(false);
    }
    const files = scanRepository(ROOT).files.filter((file) => isRuntimeFile(ROOT, path.join(ROOT, file)));
    expect(files).toEqual([
      path.join("app", "[[...path]]", "route.ts"),
      "next.config.ts",
      "proxy.ts",
      path.join("src", "boundary", "authorize.ts"),
      path.join("src", "boundary", "denial.ts"),
    ]);
    for (const file of files) {
      const parsed = parseSource(readFileSync(path.join(ROOT, file), "utf8"), file, { runtime: true });
      expect(parsed.runtimeReferences, file).toEqual([]);
      expect(parsed.computed, file).toEqual([]);
      expect(parsed.loaders, file).toEqual([]);
      expect(parsed.nonLiteral, file).toEqual([]);
      expect(parsed.loaderImports, file).toEqual([]);
      expect(parsed.specifiers.every((entry) => isRuntimeAllowedSpecifier(entry.specifier, entry.typeOnly === true)), file).toBe(true);
      // No runtime value is imported from any package: every non-alias specifier is type-only.
      expect(parsed.specifiers.filter((entry) => !entry.specifier.startsWith("@/")).every((entry) => entry.typeOnly === true), file).toBe(true);
    }
    expect(RUNTIME_REFUSED_IDENTIFIERS).toEqual(expect.arrayContaining(["process", "globalThis", "module", "require", "eval", "Function", "Reflect", "fetch", "setTimeout"]));
  });

  it("passes the command-line check", () => {
    const run = spawnSync(process.execPath, [CHECK_CLI], { cwd: ROOT, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(
      /^Import boundary intact: \d+ source files, manifest, lockfile and configuration checked\.\n$/,
    );
  });
});

describe("planted forbidden imports", () => {
  it("covers every fixture exactly once", () => {
    expect(readdirSync(FIXTURES).sort()).toEqual(
      [...Object.keys(PLANTED), ...Object.keys(PLANTED_WITH_COMMENT), ...CONTROLS, ...RUNTIME_CONTROLS].sort(),
    );
    expect(RUNTIME_ONLY.every((name) => name in PLANTED)).toBe(true);
  });

  it.each([...Object.entries(PLANTED), ...Object.entries(PLANTED_WITH_COMMENT)])(
    "%s is refused by rule %s when planted as runtime source",
    (name, rule) => {
      const violations = checkSource(fixture(name), RUNTIME_PLANT, context);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.map((violation) => violation.rule)).toContain(rule);
      for (const violation of violations) {
        expect(violation.file).toBe(path.join("src", "planted.ts"));
        expect(violation.specifier.length).toBeGreaterThan(0);
        expect(violation.message.length).toBeGreaterThan(0);
        expect(violation.line).toBeGreaterThan(0);
      }
    },
  );

  it.each(Object.entries(PLANTED).filter(([name]) => !RUNTIME_ONLY.includes(name)))(
    "%s is still refused (rule %s) when planted outside runtime source",
    (name, rule) => {
      const violations = checkSource(fixture(name), TOOL_PLANT, context);
      expect(violations.map((violation) => violation.rule), name).toContain(rule);
    },
  );

  it.each(RUNTIME_ONLY)("%s is accepted outside runtime source, where the allowlist does not apply", (name) => {
    expect(checkSource(fixture(name), TOOL_PLANT, context)).toEqual([]);
  });

  it.each(CONTROLS)("%s passes as a clean control", (name) => {
    expect(checkSource(fixture(name), path.join(ROOT, "tests", "unit", "control.ts"), context)).toEqual([]);
  });

  it.each(RUNTIME_CONTROLS)("%s passes as a clean runtime control", (name) => {
    expect(checkSource(fixture(name), RUNTIME_PLANT, context)).toEqual([]);
    expect(checkSource(fixture(name), path.join(ROOT, "proxy.ts"), context)).toEqual([]);
  });

  it("refuses the reproduced getBuiltinModule proxy on three independent rules", () => {
    const rules = new Set(checkSource(fixture("s7-getbuiltinmodule-proxy.txt"), path.join(ROOT, "proxy.ts"), context).map((violation) => violation.rule));
    expect(rules).toEqual(new Set([RULES.indirectLoader, RULES.computedAccess, RULES.runtimeReference]));
    withPlantedRepository({ "proxy.ts": fixture("s7-getbuiltinmodule-proxy.txt") }, (root) => {
      const run = spawnSync(process.execPath, [CHECK_CLI, "--root", root], { cwd: ROOT, encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`${RULES.indirectLoader}: proxy.ts:7 -> getBuiltinModule`);
      expect(run.stderr).toContain(`${RULES.computedAccess}: proxy.ts:8 -> builtin["create" + "Require"]`);
      expect(run.stderr).toContain(`${RULES.runtimeReference}: proxy.ts:7 -> process`);
    });
  });

  it("refuses both reproduced next-internal loaders planted as proxy.ts, in the scan and the command line", () => {
    for (const [name, specifier] of [
      ["s9-evalmanifest-proxy.txt", "next/dist/server/load-manifest.external"],
      ["s9-requirepage-proxy.txt", "next/dist/server/require"],
    ] as const) {
      const violations = checkSource(fixture(name), path.join(ROOT, "proxy.ts"), context);
      expect(violations.map((violation) => [violation.rule, violation.specifier, violation.line]), name).toEqual([
        [RULES.runtimeImport, specifier, 2],
      ]);
      withPlantedRepository({ "proxy.ts": fixture(name) }, (root) => {
        const run = spawnSync(process.execPath, [CHECK_CLI, "--root", root], { cwd: ROOT, encoding: "utf8" });
        expect(run.status, name).toBe(1);
        expect(run.stderr, name).toContain(`${RULES.runtimeImport}: proxy.ts:2 -> ${specifier}`);
        expect(run.stderr, name).toContain("Import boundary violated: 1 finding(s)");
      });
    }
  });

  it("records whether each specifier is type-only and judges the runtime allowlist by it", () => {
    const parsed = parseSource(fixture("clean-runtime-types.txt"), "proxy.ts", { runtime: true });
    expect(parsed.specifiers.map((entry) => [entry.specifier, entry.typeOnly])).toEqual([
      ["next", true],
      ["next/server", true],
      ["next/server", true],
      ["@/src/boundary/authorize", false],
    ]);
    expect(parsed.computed).toEqual([]);
    const mixed = parseSource(fixture("runtime-next-mixed-import.txt"), "planted.ts");
    expect(mixed.specifiers.map((entry) => [entry.specifier, entry.typeOnly])).toEqual([["next/server", false]]);
    expect(parseSource(fixture("runtime-next-reexport.txt"), "planted.ts").specifiers[0]?.typeOnly).toBe(false);
    expect(parseSource('import "next/server";\n', "planted.ts").specifiers[0]?.typeOnly).toBe(false);
    expect(parseSource('import type Next = require("next");\n', "planted.ts").specifiers[0]?.typeOnly).toBe(true);
    expect(parseSource('export type P = import("next").NextConfig;\n', "planted.ts").specifiers[0]?.typeOnly).toBe(true);
    expect(parseSource('export const p = import("next");\n', "planted.ts").specifiers[0]?.typeOnly).toBe(false);
    expect(parseSource('/// <reference types="next" />\n', "planted.ts").specifiers[0]?.typeOnly).toBe(true);
    expect(parseSource('/// <reference path="./x.d.ts" />\n', "planted.ts").specifiers[0]?.typeOnly).toBe(false);
    expect(parseSource('export {} from "next";\n', "planted.ts").specifiers[0]?.typeOnly).toBe(false);
    expect(parseSource('import {} from "next";\n', "planted.ts").specifiers[0]?.typeOnly).toBe(false);
  });

  it("fails a repository scan and the command-line check when planted as a real file", () => {
    withPlantedRepository({ "src/planted.ts": fixture("customer-web-package.txt") }, (root) => {
      const result = scanRepository(root);
      expect(result.violations.map((violation) => [violation.rule, violation.file, violation.line])).toEqual([
        [RULES.organizationPackage, path.join("src", "planted.ts"), 1],
      ]);
      const run = spawnSync(process.execPath, [CHECK_CLI, "--root", root], { cwd: ROOT, encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        `${RULES.organizationPackage}: ${path.join("src", "planted.ts")}:1 -> @pennilogic/web/session`,
      );
      expect(run.stderr).toContain("Import boundary violated: 1 finding(s)");
      expect(run.stdout).toBe("");
    });
  });

  it("fails when an evasion form is planted into an existing runtime file", () => {
    const denial = readFileSync(path.join(ROOT, "src", "boundary", "denial.ts"), "utf8");
    for (const name of ["concatenated-dynamic-import.txt", "create-require.txt", "computed-process-member.txt", "package-subpath-escape.txt", "runtime-fetch.txt"]) {
      withPlantedRepository({ "src/boundary/denial.ts": `${denial}\n${fixture(name)}` }, (root) => {
        const rules = scanRepository(root).violations.map((violation) => violation.rule);
        expect(rules, name).toContain(PLANTED[name]);
      });
    }
  });

  it("fails when a deeply nested file escapes the repository", () => {
    withPlantedRepository({ "app/(admin)/nested/page.tsx": fixture("deep-relative-escape.txt") }, (root) => {
      expect(scanRepository(root).violations.map((violation) => violation.rule)).toEqual([RULES.escapesRepository]);
    });
  });

  it("refuses relative imports in runtime source even when they stay inside the repository", () => {
    withPlantedRepository({ "app/(admin)/nested/page.tsx": fixture("relative-escape.txt") }, (root) => {
      expect(scanRepository(root).violations.map((violation) => violation.rule)).toEqual([RULES.runtimeImport]);
    });
  });

  it("accepts the same hops outside runtime source when they do not reach the root", () => {
    withPlantedRepository({ "tools/(admin)/nested/page.tsx": fixture("relative-escape.txt") }, (root) => {
      expect(scanRepository(root).violations).toEqual([]);
    });
  });

  it("uses the repository root when --root has no value", () => {
    const run = spawnSync(process.execPath, [CHECK_CLI, "--root"], { cwd: ROOT, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Import boundary intact");
  });
});

describe("links and real paths", () => {
  it("refuses a directory link inside the tree and an import that travels through it", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "admin-import-boundary-outside-"));
    writeFileSync(path.join(outside, "profile.ts"), "export const profile = 1;\n");
    const root = plantedRepository({});
    try {
      mkdirSync(path.join(root, "src", "boundary"), { recursive: true });
      if (!tryLinkDirectory(outside, path.join(root, "src", "web"))) {
        return;
      }
      const result = scanRepository(root);
      expect(result.violations).toEqual([
        {
          rule: RULES.escapesRepository,
          file: path.join("src", "web"),
          specifier: path.join("src", "web"),
          message: "Symbolic links and junctions are refused inside the repository.",
        },
      ]);
      expect(result.files).toEqual(["next.config.ts"]);
      const linkedContext = { root, declared: context.declared };
      const through = checkSpecifier("../web/profile", path.join(root, "src", "boundary", "denial.ts"), linkedContext);
      expect(through?.rule).toBe(RULES.escapesRepository);
      expect(checkSpecifier("@/src/web/profile", path.join(root, "proxy.ts"), linkedContext)?.rule).toBe(
        RULES.escapesRepository,
      );
      expect(canonical(path.join(root, "src", "web", "profile.ts"))).toBe(canonical(path.join(outside, "profile.ts")));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("canonicalizes paths that do not exist yet through their deepest existing ancestor", () => {
    const missing = path.join(ROOT, "src", "does-not-exist", "deeper", "file.ts");
    expect(canonical(missing)).toBe(path.join(canonical(path.join(ROOT, "src")), "does-not-exist", "deeper", "file.ts"));
    expect(canonical(ROOT)).toBe(canonical(path.join(ROOT, "src", "..")));
    const drive = path.parse(ROOT).root;
    const rootless = path.join(drive, `definitely-missing-${String(process.pid)}`, "x");
    expect(canonical(rootless)).toBe(path.join(canonical(drive), `definitely-missing-${String(process.pid)}`, "x"));
  });
});

describe("specifier rules", () => {
  const file = path.join(ROOT, "src", "boundary", "example.ts");

  it("extracts static, type-only, side-effect, re-export, alias, dynamic, template and require specifiers", () => {
    expect(extractSpecifiers(fixture("clean-source.txt"))).toEqual([
      "next",
      "next/server",
      "vitest",
      "./c",
      "../d",
      "@/src/boundary/authorize",
      "eslint",
      "node:fs",
      "vitest",
    ]);
    expect(extractSpecifiers("")).toEqual([]);
    const parsed = parseSource(fixture("clean-source.txt"), "clean.ts");
    expect(parsed.nonLiteral).toEqual([]);
    expect(parsed.loaders).toEqual([]);
    expect(parsed.specifiers.map((entry) => entry.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("reports every dynamic call that is not exactly one string literal, with its line", () => {
    expect(parseSource(fixture("variable-require.txt"), "planted.ts").nonLiteral).toEqual([
      { specifier: "require(name)", line: 2 },
    ]);
    expect(parseSource(fixture("template-dynamic-import.txt"), "planted.ts").nonLiteral).toEqual([
      { specifier: "import(`@pennilogic/${target}`)", line: 4 },
    ]);
    expect(parseSource(fixture("concatenated-dynamic-import.txt"), "planted.ts").nonLiteral).toEqual([
      { specifier: 'import("@penni" + "logic/web/session")', line: 1 },
    ]);
    expect(parseSource(fixture("two-argument-dynamic-import.txt"), "planted.ts").nonLiteral).toEqual([
      { specifier: 'import("@pennilogic/web", { with: { type: "json" } })', line: 1 },
    ]);
    expect(parseSource(fixture("commented-dynamic-import.txt"), "planted.ts").specifiers).toEqual([
      { specifier: "@pennilogic/web", line: 1, typeOnly: false },
    ]);
  });

  it("reports indirect loaders wherever they appear", () => {
    expect(parseSource(fixture("create-require.txt"), "planted.ts").loaders.map((entry) => entry.specifier)).toEqual([
      "createRequire",
      "createRequire",
    ]);
    expect(parseSource(fixture("module-create-require.txt"), "planted.ts").loaders).toEqual([
      { specifier: "createRequire", line: 3 },
      { specifier: "createRequire", line: 3 },
    ]);
    expect(parseSource(fixture("module-create-require.txt"), "planted.ts").loaderImports).toEqual([{ specifier: "module", line: 1 }]);
    expect(parseSource(fixture("eval-loader.txt"), "planted.ts").loaders).toEqual([
      { specifier: "eval", line: 1 },
      { specifier: "eval", line: 1 },
    ]);
    expect(parseSource(fixture("function-constructor.txt"), "planted.ts").loaders.map((entry) => entry.specifier)).toEqual(
      ["new Function", "Function"],
    );
    expect(parseSource(fixture("function-via-constructor.txt"), "planted.ts").loaders.map((entry) => entry.specifier)).toEqual([
      "constructor",
      "constructor",
    ]);
    expect(parseSource(fixture("require-resolve.txt"), "planted.ts").loaders).toEqual([
      { specifier: "require.resolve", line: 1 },
      { specifier: "require", line: 1 },
    ]);
    expect(parseSource(fixture("import-meta-resolve.txt"), "planted.ts").loaders).toEqual([
      { specifier: "import.meta.resolve", line: 1 },
    ]);
    expect(parseSource(fixture("aliased-require.txt"), "planted.ts").loaders).toEqual([{ specifier: "require", line: 1 }]);
    expect(parseSource(fixture("module-require-member.txt"), "planted.ts").loaders.map((entry) => entry.specifier)).toEqual([
      "require",
      "require",
    ]);
    expect(parseSource(fixture("module-require-member.txt"), "planted.ts").loaderImports.map((entry) => entry.specifier)).toEqual([
      "module",
    ]);
    expect(parseSource(fixture("require-main-require.txt"), "planted.ts").loaders.map((entry) => entry.specifier)).toEqual([
      "require",
      "require",
      "require",
    ]);
    expect(parseSource(fixture("literal-key-module-binding.txt"), "planted.ts").loaders.map((entry) => entry.specifier)).toEqual([
      "createRequire",
    ]);
    expect(parseSource(fixture("literal-key-module-binding.txt"), "planted.ts").loaderImports.map((entry) => entry.specifier)).toEqual([
      "module",
    ]);
    expect(parseSource(fixture("s7-getbuiltinmodule-proxy.txt"), "proxy.ts").loaders.map((entry) => entry.specifier)).toEqual([
      "getBuiltinModule",
      "getBuiltinModule",
    ]);
  });

  it("records loader-builtin imports in every form and honours the per-file allowances", () => {
    expect(parseSource(fixture("vm-loader.txt"), "planted.ts").loaderImports).toEqual([{ specifier: "vm", line: 1 }]);
    expect(parseSource(fixture("worker-threads-loader.txt"), "planted.ts").loaderImports).toEqual([{ specifier: "worker_threads", line: 1 }]);
    expect(parseSource('const cp = require("child_process");\n', "planted.cjs").loaderImports).toEqual([{ specifier: "child_process", line: 1 }]);
    expect(parseSource('import cp = require("node:child_process");\n', "planted.cts").loaderImports).toEqual([{ specifier: "child_process", line: 1 }]);
    expect(parseSource('export * from "node:process";\n', "planted.ts").loaderImports).toEqual([{ specifier: "process", line: 1 }]);
    expect(parseSource('import { readFileSync } from "node:fs";\n', "planted.ts").loaderImports).toEqual([]);
    expect(checkSource(fixture("child-process-loader.txt"), path.join(ROOT, "tools", "next-cli.mjs"), context)).toEqual([]);
    expect(checkSource(fixture("child-process-loader.txt"), path.join(ROOT, "tools", "other.mjs"), context).map((violation) => violation.rule)).toEqual([
      RULES.indirectLoader,
    ]);
    expect(checkSource(fixture("vm-loader.txt"), path.join(ROOT, "tools", "next-cli.mjs"), context).map((violation) => violation.rule)).toEqual([
      RULES.indirectLoader,
      RULES.indirectLoader,
      RULES.indirectLoader,
    ]);
    expect(Object.keys(LOADER_BUILTIN_ALLOWANCES).sort()).toEqual([
      "tests/smoke/server.test.ts",
      "tests/unit/import-boundary.test.ts",
      "tools/import-boundary/scan.mjs",
      "tools/next-cli.mjs",
    ]);
  });

  it("refuses computed member access on refused bindings everywhere and on anything in runtime source", () => {
    expect(parseSource(fixture("computed-process-member.txt"), "planted.mjs").computed).toEqual([
      { specifier: 'process["getBuiltin" + "Module"]', line: 1 },
    ]);
    expect(parseSource(fixture("computed-module-binding.txt"), "planted.mjs").computed).toEqual([
      { specifier: 'm["create" + "Require"]', line: 3 },
    ]);
    // Default, named and side-effect imports of a loader builtin are tracked the same way.
    expect(parseSource('import m from "node:module";\nconst k = m["create" + "Require"];\n', "planted.mjs").computed).toHaveLength(1);
    expect(parseSource('import { builtinModules as b } from "module";\nconst k = b["len" + "gth"];\n', "planted.mjs").computed).toHaveLength(1);
    expect(parseSource('import "node:module";\nconst o = {}; const k = "a"; const v = o[k];\n', "planted.mjs").computed).toEqual([]);
    expect(parseSource(fixture("computed-globalthis.txt"), "planted.mjs").computed).toEqual([
      { specifier: 'globalThis["Func" + "tion"]', line: 1 },
    ]);
    expect(parseSource(fixture("parenthesized-import-meta.txt"), "planted.mjs").loaders).toEqual([
      { specifier: "import.meta.resolve", line: 1 },
    ]);
    expect(parseSource('export const planted = (import.meta)["res" + "olve"]("x");\n', "planted.mjs").computed).toEqual([
      { specifier: '(import.meta)["res" + "olve"]', line: 1 },
    ]);
    expect(parseSource('const k = "x"; export const planted = (process as unknown as Record<string, unknown>)[k];\n', "planted.ts").computed).toHaveLength(1);
    expect(parseSource('export const planted = process!["binding"];\n', "planted.ts").loaders.map((entry) => entry.specifier)).toEqual(["binding"]);
    // Outside runtime source, computed access on ordinary objects stays acceptable.
    expect(parseSource("const o = { a: 1 }; const k = 'a'; export const planted = o[k];\n", "planted.mjs").computed).toEqual([]);
    expect(parseSource("export const planted = [1, 2][0];\n", "planted.mjs").computed).toEqual([]);
    // Inside runtime source, only numeric and literal keys are acceptable.
    expect(parseSource("const o = { a: 1 }; const k = 'a'; export const planted = o[k];\n", "planted.ts", { runtime: true }).computed).toHaveLength(1);
    expect(parseSource("export const planted = [1, 2][0];\n", "planted.ts", { runtime: true }).computed).toEqual([]);
    expect(parseSource('export const planted = { a: 1 }["a"];\n', "planted.ts", { runtime: true }).computed).toEqual([]);
  });

  it("records runtime references only for runtime source", () => {
    const source = "export const planted = [globalThis, fetch, setTimeout, import.meta, process.env, window];\n";
    expect(parseSource(source, "planted.ts").runtimeReferences).toEqual([]);
    expect(parseSource(source, "planted.ts", { runtime: true }).runtimeReferences.map((entry) => entry.specifier)).toEqual([
      "globalThis",
      "fetch",
      "setTimeout",
      "import.meta",
      "process",
      "window",
    ]);
    expect(parseSource('export const planted = globalThis["fetch"];\n', "planted.ts", { runtime: true }).runtimeReferences.map((entry) => entry.specifier)).toEqual([
      "fetch",
      "globalThis",
    ]);
    expect(parseSource('export const planted = (x: { process: number }) => x.process;\n', "planted.ts", { runtime: true }).runtimeReferences.map((entry) => entry.specifier)).toEqual([
      "process",
      "process",
    ]);
    // `this` in any position is a route to the global object in runtime source only.
    expect(parseSource(fixture("runtime-this.txt"), "planted.ts", { runtime: true }).runtimeReferences).toEqual([{ specifier: "this", line: 2 }]);
    expect(parseSource("export const planted = this;\n", "planted.ts", { runtime: true }).runtimeReferences).toEqual([{ specifier: "this", line: 1 }]);
    expect(parseSource(fixture("runtime-this.txt"), "planted.ts").runtimeReferences).toEqual([]);
    // Computed keys in patterns, object literals and classes are refused in runtime source; literal keys pass.
    expect(parseSource(fixture("runtime-computed-destructuring.txt"), "planted.ts", { runtime: true }).computed).toEqual([{ specifier: "[id]: v", line: 3 }]);
    expect(parseSource("const k = 'a'; export const planted = { [k]: 1 };\n", "planted.ts", { runtime: true }).computed).toEqual([{ specifier: "[k]: 1", line: 1 }]);
    expect(parseSource("const k = 'a'; export class Planted { [k] = 1; }\n", "planted.ts", { runtime: true }).computed).toHaveLength(1);
    expect(parseSource('export const planted = { ["a"]: 1, [0]: 2 };\n', "planted.ts", { runtime: true }).computed).toEqual([]);
    expect(parseSource(fixture("runtime-computed-destructuring.txt"), "planted.ts").computed).toEqual([]);
    // Reflect is a loader everywhere: it reaches members without naming them.
    expect(parseSource(fixture("reflect-get-process.txt"), "planted.mjs").loaders).toEqual([{ specifier: "Reflect", line: 1 }]);
    expect(parseSource("export const planted = Reflect.apply(Function, null, []);\n", "planted.mjs").loaders.map((entry) => entry.specifier)).toEqual(["Reflect", "Function"]);
  });

  it("parses each script kind and reads type-level and triple-slash references", () => {
    expect(extractSpecifiers(fixture("import-type-node.txt"), "planted.d.ts")).toEqual(["@pennilogic/web"]);
    expect(extractSpecifiers(fixture("import-equals-require.txt"), "planted.ts")).toEqual(["@pennilogic/web"]);
    expect(extractSpecifiers(fixture("triple-slash-reference.txt"), "planted.ts")).toEqual(["../../web/src/session.d.ts"]);
    expect(extractSpecifiers('/// <reference types="next" />\n', "env.d.ts")).toEqual(["next"]);
    expect(extractSpecifiers('/// <amd-dependency path="legacy" />\n', "legacy.ts")).toEqual(["legacy"]);
    expect(extractSpecifiers(fixture("clean-module.txt"), "planted.mjs")).toEqual(["node:fs"]);
    expect(extractSpecifiers(fixture("clean-module.txt"), "planted.cjs")).toEqual(["node:fs"]);
    expect(extractSpecifiers(fixture("clean-module.txt"), "planted.js")).toEqual(["node:fs"]);
    expect(extractSpecifiers('import x from "y";\nexport default <div />;\n', "page.tsx")).toEqual(["y"]);
    expect(extractSpecifiers('import x from "y";\nexport default <div />;\n', "page.jsx")).toEqual(["y"]);
  });

  it("fails closed on syntactically invalid specifiers instead of skipping them", () => {
    // The parser tolerates these forms with a diagnostic; whatever it kept is checked as written.
    expect(checkSource("import x from web;\n", file, context).map((violation) => [violation.rule, violation.specifier])).toEqual([
      [RULES.undeclaredDependency, "web"],
    ]);
    expect(checkSource("export type P = import(Web).Session;\n", file, context).map((violation) => violation.rule)).toEqual([
      RULES.undeclaredDependency,
    ]);
  });

  it("accepts builtins, declared packages and their plain subpaths, and in-repository paths", () => {
    const accepted = [
      "node:fs",
      "fs",
      "path",
      "node:module",
      "next",
      "next/server",
      "next/dist/server/web/spec-extension/request",
      "vitest/config",
      "@eslint/js",
      "typescript",
      "typescript/lib/typescript.js",
      "./denial",
      "../boundary/authorize",
      "../../tests/support/denial",
      "@/proxy",
      "@/app/[[...path]]/route",
      "@/tests/fixtures/import-boundary/clean-source.txt",
    ];
    for (const specifier of accepted) {
      expect(checkSpecifier(specifier, file, context), specifier).toBeNull();
    }
  });

  it("refuses organization packages, customer names, escapes, absolute, remote and subpath specifiers, and undeclared packages", () => {
    const refused: [string, string][] = [
      ["@pennilogic/web", RULES.organizationPackage],
      ["@PenniLogic/Web/session", RULES.organizationPackage],
      ["@pennilogic/admin-contract", RULES.organizationPackage],
      ["pennilogic-web", RULES.organizationPackage],
      ["@pennilogic/shared-client", RULES.customerCode],
      ["customer-web", RULES.customerCode],
      ["some-vendor/customer-client/session", RULES.customerCode],
      ["./customer-web/layout", RULES.customerCode],
      ["@/src/shared-client/index", RULES.customerCode],
      ["../../../web/src/session", RULES.escapesRepository],
      ["../../../../other/thing", RULES.escapesRepository],
      ["@/../web/src/session", RULES.escapesRepository],
      ["@/node_modules/next/server", RULES.escapesRepository],
      ["../../node_modules/react", RULES.escapesRepository],
      ["/absolute/web/session", RULES.absoluteOrRemote],
      ["\\\\share\\web\\session", RULES.absoluteOrRemote],
      ["C:\\checkouts\\web\\session", RULES.absoluteOrRemote],
      ["file:../web/session", RULES.absoluteOrRemote],
      ["https://example.invalid/session.js", RULES.absoluteOrRemote],
      ["data:text/javascript,export default 1", RULES.absoluteOrRemote],
      ["node_modules/next/server", RULES.absoluteOrRemote],
      ["#customer/session", RULES.absoluteOrRemote],
      ["next/../../../web/src/session", RULES.escapesRepository],
      ["next/./dist/server", RULES.escapesRepository],
      ["@types/node/../../web/session", RULES.escapesRepository],
      ["typescript/lib/..", RULES.escapesRepository],
      ["next\\dist\\server", RULES.escapesRepository],
      ["next/%2e%2e/web", RULES.escapesRepository],
      ["@/%2e%2e/web/session", RULES.escapesRepository],
      ["./%2e%2e/web", RULES.escapesRepository],
      ["node:../../web/session", RULES.undeclaredDependency],
      ["node:not-a-builtin", RULES.undeclaredDependency],
      ["undeclared-sdk", RULES.undeclaredDependency],
      ["@scope/undeclared", RULES.undeclaredDependency],
    ];
    for (const [specifier, rule] of refused) {
      expect(checkSpecifier(specifier, file, context)?.rule, specifier).toBe(rule);
    }
  });

  it("reports the importing file relative to the root, or verbatim when it is the root itself", () => {
    expect(checkSpecifier("undeclared-sdk", file, context)?.file).toBe(path.join("src", "boundary", "example.ts"));
    expect(checkSpecifier("undeclared-sdk", ROOT, context)?.file).toBe(ROOT);
    expect(checkSource(fixture("undeclared-package.txt"), ROOT, context)[0]?.file).toBe(ROOT);
  });

  it("derives package names from scoped and unscoped specifiers", () => {
    expect(packageNameOf("next/server")).toBe("next");
    expect(packageNameOf("@eslint/js/flat")).toBe("@eslint/js");
    expect(packageNameOf("lonely")).toBe("lonely");
  });
});

describe("manifest and lockfile provenance", () => {
  it("refuses customer or organization packages declared as any kind of dependency", () => {
    const planted = clone(manifest);
    planted.dependencies = { ...planted.dependencies, "@pennilogic/web": "1.0.0" };
    planted.optionalDependencies = { "customer-web": "2.0.0" };
    planted.peerDependencies = { "@pennilogic/shared-client": "3.0.0" };
    const rules = checkManifest(planted).map((violation) => violation.rule).sort();
    expect(rules).toEqual([RULES.customerCode, RULES.customerCode, RULES.organizationPackage].sort());
  });

  it("refuses links, files, workspaces, git, URLs, aliases and version ranges", () => {
    const planted = clone(manifest);
    planted.devDependencies = {
      ...planted.devDependencies,
      "planted-file": "file:../web",
      "planted-link": "link:../web",
      "planted-workspace": "workspace:*",
      "planted-git": "git+https://example.invalid/web.git",
      "planted-url": "https://example.invalid/web.tgz",
      "planted-alias": "npm:other@1.0.0",
      "planted-range": "^1.0.0",
    };
    const violations = checkManifest(planted);
    expect(violations).toHaveLength(7);
    expect(new Set(violations.map((violation) => violation.rule))).toEqual(new Set([RULES.nonRegistryDependency]));
  });

  it("refuses workspaces, bundled dependencies, overrides and subpath imports", () => {
    const planted = {
      ...clone(manifest),
      workspaces: ["../web"],
      bundleDependencies: ["x"],
      bundledDependencies: ["y"],
      overrides: {},
      imports: { "#customer/*": "../web/src/*" },
    };
    const violations = checkManifest(planted);
    expect(violations.map((violation) => violation.specifier).sort()).toEqual([
      "bundleDependencies",
      "bundledDependencies",
      "imports",
      "overrides",
      "workspaces",
    ]);
    expect(new Set(violations.map((violation) => violation.rule))).toEqual(new Set([RULES.workspaceOrBundle]));
  });

  it("refuses lockfile entries that are linked, unresolved, non-registry, unhashed, outside node_modules or refused packages", () => {
    const planted = clone(lockfile);
    const packages = planted.packages ?? {};
    const registry = "https://registry.npmjs.org/";
    packages["node_modules/planted-link"] = { link: true, resolved: "../web" };
    packages["node_modules/planted-git"] = { resolved: "git+ssh://example.invalid/web.git", integrity: "sha512-x" };
    packages["node_modules/planted-unhashed"] = { resolved: `${registry}planted-unhashed/-/planted-unhashed-1.0.0.tgz`, integrity: "sha1-x" };
    packages["node_modules/planted-missing"] = {};
    packages["../web"] = { resolved: `${registry}web/-/web-1.0.0.tgz`, integrity: "sha512-x" };
    packages["node_modules/@pennilogic/web"] = { resolved: `${registry}@pennilogic/web/-/web-1.0.0.tgz`, integrity: "sha512-x" };
    packages["node_modules/nested/node_modules/customer-web"] = { resolved: `${registry}customer-web/-/customer-web-1.0.0.tgz`, integrity: "sha512-x" };
    const violations = checkLockfile(planted, manifest);
    const bySpecifier = new Map<string, string[]>();
    for (const violation of violations) {
      expect(violation.rule).toBe(RULES.lockfile);
      expect(violation.file).toBe("package-lock.json");
      bySpecifier.set(violation.specifier, [...(bySpecifier.get(violation.specifier) ?? []), violation.message]);
    }
    expect([...bySpecifier.keys()].sort()).toEqual([
      "../web",
      "node_modules/@pennilogic/web",
      "node_modules/nested/node_modules/customer-web",
      "node_modules/planted-git",
      "node_modules/planted-link",
      "node_modules/planted-missing",
      "node_modules/planted-unhashed",
    ]);
    expect(bySpecifier.get("node_modules/planted-link")).toEqual(expect.arrayContaining([expect.stringContaining("Linked")]));
    expect(bySpecifier.get("../web")).toEqual(expect.arrayContaining([expect.stringContaining("workspace paths")]));
    expect(bySpecifier.get("node_modules/planted-missing")).toHaveLength(2);
    expect(bySpecifier.get("node_modules/@pennilogic/web")).toEqual([expect.stringContaining("Refused package")]);
  });

  it("refuses a lockfile whose version or root entry disagrees with the manifest", () => {
    const planted = clone(lockfile);
    planted.lockfileVersion = 2;
    const packages = planted.packages ?? {};
    packages[""] = { ...packages[""], dependencies: { next: "0.0.0" } };
    const specifiers = checkLockfile(planted, manifest).map((violation) => violation.specifier);
    expect(specifiers).toEqual(["lockfileVersion", "dependencies"]);
    expect(checkLockfile({}, {}).map((violation) => violation.specifier)).toEqual(["lockfileVersion"]);
  });

  it("collects declared names across every dependency field", () => {
    expect([...declaredDependencies({ dependencies: { a: "1.0.0" }, peerDependencies: { b: "1.0.0" } })].sort()).toEqual(["a", "b"]);
    expect(declaredDependencies({}).size).toBe(0);
  });
});

describe("resolution surfaces", () => {
  const options = () => clone(tsconfig["compilerOptions"] as Record<string, unknown>);

  it("refuses a remapped alias, extra mappings, relocating options and external configuration", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["compilerOptions.paths", { ...tsconfig, compilerOptions: { ...options(), paths: { "@/*": ["../web/src/*"] } } }],
      ["compilerOptions.paths", { ...tsconfig, compilerOptions: { ...options(), paths: { "@/*": ["./*"], "react/customer/*": ["../web/*"] } } }],
      ["compilerOptions.paths", { ...tsconfig, compilerOptions: { ...options(), paths: undefined } }],
      ["compilerOptions.baseUrl", { ...tsconfig, compilerOptions: { ...options(), baseUrl: ".." } }],
      ["compilerOptions.rootDirs", { ...tsconfig, compilerOptions: { ...options(), rootDirs: [".", "../web"] } }],
      ["compilerOptions.typeRoots", { ...tsconfig, compilerOptions: { ...options(), typeRoots: ["../web/types"] } }],
      ["extends", { ...tsconfig, extends: "../web/tsconfig.json" }],
      ["references", { ...tsconfig, references: [{ path: "../web" }] }],
      ["files", { ...tsconfig, files: ["../web/src/session.ts"] }],
      ["include.../web/**/*.ts", { ...tsconfig, include: ["**/*.ts", "../web/**/*.ts"] }],
    ];
    for (const [specifier, planted] of cases) {
      const violations = checkTsconfig(planted);
      expect(violations.map((violation) => violation.rule), specifier).toEqual(
        violations.map(() => RULES.resolutionSurface),
      );
      expect(violations.map((violation) => violation.specifier), specifier).toContain(specifier);
    }
    expect(checkTsconfig(undefined).map((violation) => violation.specifier)).toEqual(["tsconfig.json"]);
    expect(checkTsconfig({ compilerOptions: null }).map((violation) => violation.specifier)).toEqual(["compilerOptions.paths"]);
    expect(checkTsconfig({ ...tsconfig, include: [42] }).map((violation) => violation.specifier)).toEqual(["include.42"]);
  });

  it("refuses next.config.ts keys, calls, spreads and computed names outside the allowlist", () => {
    const base = 'import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {\n';
    const cases: [string, string][] = [
      ["turbopack", `${base}  turbopack: { resolveAlias: { react: "../web/node_modules/react" } },\n};\n\nexport default nextConfig;\n`],
      ["transpilePackages", `${base}  transpilePackages: ["@pennilogic/web"],\n};\n\nexport default nextConfig;\n`],
      ["experimental", `${base}  experimental: { externalDir: true },\n};\n\nexport default nextConfig;\n`],
      ["outputFileTracingRoot", `${base}  outputFileTracingRoot: "..",\n};\n\nexport default nextConfig;\n`],
      ["webpack", `${base}  webpack(config) {\n    return config;\n  },\n};\n\nexport default nextConfig;\n`],
      ["withPlugin(nextConfig)", `${base}};\n\nexport default withPlugin(nextConfig);\n`],
      ["...shared", `${base}  ...shared,\n};\n\nexport default nextConfig;\n`],
      ['["turbo" + "pack"]: {}', `${base}  ["turbo" + "pack"]: {},\n};\n\nexport default nextConfig;\n`],
      ["reactStrictMode", `const reactStrictMode = true;\nexport default { reactStrictMode, basePath: "/admin" };\n`],
    ];
    for (const [specifier, source] of cases) {
      const violations = checkNextConfig(source);
      expect(violations.length, specifier).toBeGreaterThan(0);
      expect(new Set(violations.map((violation) => violation.rule)), specifier).toEqual(new Set([RULES.resolutionSurface]));
      expect(violations.map((violation) => violation.line).every((line) => (line ?? 0) > 0), specifier).toBe(true);
      if (specifier !== "reactStrictMode") {
        expect(violations.map((violation) => violation.specifier), specifier).toContain(specifier);
      } else {
        expect(violations.map((violation) => violation.specifier), specifier).toEqual(["basePath"]);
      }
    }
    expect(NEXT_CONFIG_ALLOWED_KEYS).toEqual(["reactStrictMode", "poweredByHeader", "skipTrailingSlashRedirect", "skipProxyUrlNormalize"]);
  });

  it("fails a repository scan when configuration is planted", () => {
    withPlantedRepository({ "tsconfig.json": JSON.stringify({ ...tsconfig, compilerOptions: { ...options(), baseUrl: ".." } }) }, (root) => {
      expect(scanRepository(root).violations.map((violation) => violation.specifier)).toEqual(["compilerOptions.baseUrl"]);
    });
    withPlantedRepository({ "next.config.ts": nextConfigSource.replace("poweredByHeader: false,", 'poweredByHeader: false,\n  transpilePackages: ["@pennilogic/web"],') }, (root) => {
      expect(scanRepository(root).violations.map((violation) => violation.specifier)).toEqual(["transpilePackages"]);
    });
    withPlantedRepository({ "tsconfig.json": "{ not json" }, (root) => {
      expect(scanRepository(root).violations.map((violation) => violation.specifier)).toEqual(["tsconfig.json"]);
    });
    const root = plantedRepository({});
    try {
      rmSync(path.join(root, "tsconfig.json"));
      rmSync(path.join(root, "next.config.ts"));
      expect(scanRepository(root).violations.map((violation) => violation.specifier)).toEqual(["tsconfig.json", "next.config.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses any Next.js configuration sibling that the framework would load before next.config.ts", () => {
    expect(NEXT_CONFIG_SIBLINGS).toEqual(["next.config.js", "next.config.mjs", "next.config.cjs", "next.config.mts", "next.config.cts", "next.config.json"]);
    const planted = 'const nextConfig = { basePath: "/planted", poweredByHeader: true };\nexport default nextConfig;\n';
    for (const sibling of NEXT_CONFIG_SIBLINGS) {
      withPlantedRepository({ [sibling]: planted }, (root) => {
        const violations = scanRepository(root).violations;
        expect(violations.map((violation) => [violation.rule, violation.file]), sibling).toContainEqual([RULES.resolutionSurface, sibling]);
        const run = spawnSync(process.execPath, [CHECK_CLI, "--root", root], { cwd: ROOT, encoding: "utf8" });
        expect(run.status, sibling).toBe(1);
        expect(run.stderr, sibling).toContain(`${RULES.resolutionSurface}: ${sibling} -> ${sibling} (Only next.config.ts may exist`);
      });
    }
    const root = plantedRepository({});
    try {
      rmSync(path.join(root, "next.config.ts"));
      expect(checkNextConfigFiles(root)).toEqual([
        { rule: RULES.resolutionSurface, file: "next.config.ts", specifier: "next.config.ts", message: "The pinned next.config.ts is required." },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("source discovery", () => {
  it("walks only source extensions and skips dependency, build, VCS and coverage directories", () => {
    const root = mkdtempSync(path.join(tmpdir(), "admin-import-boundary-walk-"));
    try {
      for (const directory of IGNORED_DIRECTORIES) {
        mkdirSync(path.join(root, directory), { recursive: true });
        writeFileSync(path.join(root, directory, "skipped.ts"), fixture("undeclared-package.txt"));
      }
      mkdirSync(path.join(root, "nested", "deeper"), { recursive: true });
      for (const extension of SOURCE_EXTENSIONS) {
        writeFileSync(path.join(root, "nested", "deeper", `file${extension}`), "");
      }
      writeFileSync(path.join(root, "nested", "notes.txt"), fixture("undeclared-package.txt"));
      writeFileSync(path.join(root, "nested", "data.json"), "{}");
      const walk = listSourceFiles(root);
      const files = walk.files.map((file) => path.relative(root, file));
      expect(files).toHaveLength(SOURCE_EXTENSIONS.length);
      expect(files.every((file) => file.startsWith(path.join("nested", "deeper")))).toBe(true);
      expect(walk.links).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a manifest at the scanned root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "admin-import-boundary-empty-"));
    try {
      expect(() => scanRepository(root)).toThrow(/package\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ESLint mirror", () => {
  const configFiles = ["src/planted.ts", "app/planted/page.tsx", "proxy.ts", "next.config.ts", "tools/planted.mjs", "tests/unit/planted.test.ts", "tools/next-cli.mjs", "tools/import-boundary/scan.mjs", "tests/smoke/server.test.ts"];
  const runtimeConfigFiles = ["src/planted.ts", "app/planted/page.tsx", "proxy.ts", "next.config.ts"];
  const linted = [
    "customer-web-package.txt",
    "shared-client-bundle.txt",
    "customer-web-literal.txt",
    "unscoped-prefix.txt",
    "remote-url.txt",
    "absolute-path.txt",
    "subpath-import.txt",
    "package-subpath-escape.txt",
    "package-subpath-dot.txt",
    "alias-percent-encoded.txt",
    "create-require.txt",
    "eval-loader.txt",
    "function-constructor.txt",
    "function-via-constructor.txt",
    "require-resolve.txt",
    "import-meta-resolve.txt",
    "aliased-require.txt",
    "module-require-member.txt",
    "require-main-require.txt",
    "computed-process-member.txt",
    "computed-globalthis.txt",
    "parenthesized-import-meta.txt",
    "vm-loader.txt",
    "worker-threads-loader.txt",
    "child-process-loader.txt",
    "reflect-get-process.txt",
    "clean-module.txt",
  ];
  const lintedAsRuntime = [
    "s7-getbuiltinmodule-proxy.txt",
    "s9-evalmanifest-proxy.txt",
    "s9-requirepage-proxy.txt",
    "runtime-node-builtin.txt",
    "runtime-dev-package.txt",
    "runtime-next-value-import.txt",
    "runtime-next-default-import.txt",
    "runtime-next-mixed-import.txt",
    "runtime-next-reexport.txt",
    "runtime-next-dist-type.txt",
    "runtime-next-compiled.txt",
    "runtime-react-import.txt",
    "runtime-react-dom-server.txt",
    "runtime-fetch.txt",
    "runtime-timer.txt",
    "runtime-globalthis.txt",
    "runtime-this.txt",
    "runtime-computed-destructuring.txt",
    "computed-module-binding.txt",
    "clean-runtime-types.txt",
  ];
  interface Message {
    ruleId: string | null;
    severity: number;
    message: string;
    fatal: boolean;
  }
  let configs: Record<string, unknown>;
  let results: Record<string, Message[]>;

  beforeAll(() => {
    const run = spawnSync(process.execPath, [path.join(ROOT, "tests", "support", "eslint-mirror.mjs"), ROOT], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      input: JSON.stringify({
        configFiles,
        lint: [
          ...linted.map((name) => ({ name, filePath: "tools/planted.mjs", source: fixture(name) })),
          ...lintedAsRuntime.map((name) => ({ name: `runtime:${name}`, filePath: "src/planted.ts", source: fixture(name) })),
        ],
      }),
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    ({ configs, results } = JSON.parse(run.stdout) as { configs: typeof configs; results: typeof results });
  }, 120_000);

  function ruleIds(name: string): string[] {
    const messages = results[name] ?? [];
    expect(messages.filter((message) => message.fatal), name).toEqual([]);
    expect(messages.every((message) => message.severity === 2), name).toBe(true);
    return [...new Set(messages.map((message) => message.ruleId ?? "fatal"))].sort();
  }

  function messagesOf(name: string, ruleId: string): string[] {
    return (results[name] ?? []).filter((message) => message.ruleId === ruleId).map((message) => message.message);
  }

  function loaderPathsExcept(allowed: readonly string[]): { name: string; message: string }[] {
    return RESTRICTED_LOADER_BUILTIN_PATHS.filter((entry) => !allowed.some((name) => entry.name === name || entry.name === `node:${name}`));
  }

  it("configures no-restricted-imports as an error everywhere, refusing loader builtins per file exactly as the scanner does", () => {
    for (const file of configFiles.filter((name) => !runtimeConfigFiles.includes(name))) {
      const allowed = file in LOADER_BUILTIN_ALLOWANCES ? LOADER_BUILTIN_ALLOWANCES[file as keyof typeof LOADER_BUILTIN_ALLOWANCES] : [];
      expect(configs[file], file).toEqual([2, { patterns: [...RESTRICTED_IMPORT_PATTERNS], paths: [...RESTRICTED_IMPORT_PATHS, ...loaderPathsExcept(allowed)] }]);
    }
    expect(configs["tools/import-boundary/scan.mjs"]).toEqual(configs["tools/planted.mjs"]);
    const smokePaths = (configs["tests/smoke/server.test.ts"] as [number, { paths: { name: string }[] }])[1].paths.map((entry) => entry.name);
    expect(smokePaths).not.toContain("child_process");
    expect(smokePaths).not.toContain("node:child_process");
    expect(smokePaths).toEqual(expect.arrayContaining(["vm", "node:vm", "worker_threads", "node:worker_threads", "process", "node:process"]));
  });

  it("adds the exact type-only import allowlist and the restricted globals for runtime source", () => {
    for (const file of runtimeConfigFiles) {
      expect(configs[file], file).toEqual([
        2,
        {
          patterns: [...RESTRICTED_IMPORT_PATTERNS, ...RUNTIME_RESTRICTED_IMPORT_PATTERNS],
          paths: [...RESTRICTED_IMPORT_PATHS, ...loaderPathsExcept([])],
        },
      ]);
    }
    expect(RUNTIME_RESTRICTED_GLOBALS.map((entry) => entry.name)).toEqual([...RUNTIME_REFUSED_IDENTIFIERS]);
    expect(RUNTIME_RESTRICTED_IMPORT_PATTERNS.map((entry) => entry.regex)).toEqual(["^(?!(?:next\\/server|next)$|@/)", "^(?:next\\/server|next)$"]);
    expect(RUNTIME_RESTRICTED_IMPORT_PATTERNS[1]?.allowTypeImports).toBe(true);
    const refusedUnlessExact = new RegExp(RUNTIME_RESTRICTED_IMPORT_PATTERNS[0]?.regex ?? "");
    for (const specifier of ["next", "next/server", "@/proxy"]) {
      expect(refusedUnlessExact.test(specifier), specifier).toBe(false);
    }
    for (const specifier of ["next/dist/server/require", "next/navigation", "react", "react-dom", "react-dom/server", "node:fs", "typescript", "nextjs", "./x", "../x"]) {
      expect(refusedUnlessExact.test(specifier), specifier).toBe(true);
    }
  });

  it("reports planted organization, customer, prefixed, remote, subpath and dot-segment static imports", () => {
    const rule = "no-restricted-imports";
    expect(messagesOf("customer-web-package.txt", rule)).toEqual([expect.stringContaining("PenniLogic packages are refused")]);
    expect(messagesOf("shared-client-bundle.txt", rule)).toEqual([
      expect.stringContaining("Customer web code and shared client bundles"),
      expect.stringContaining("PenniLogic packages are refused"),
    ]);
    expect(messagesOf("customer-web-literal.txt", rule)).toEqual([expect.stringContaining("Customer web code and shared client bundles")]);
    expect(messagesOf("unscoped-prefix.txt", rule)).toEqual([expect.stringContaining("PenniLogic packages are refused")]);
    expect(messagesOf("remote-url.txt", rule)).toEqual([expect.stringContaining("Import only repository files")]);
    expect(messagesOf("absolute-path.txt", rule)).toEqual([expect.stringContaining("Import only repository files")]);
    expect(messagesOf("subpath-import.txt", rule)).toEqual([expect.stringContaining("Import only repository files")]);
    expect(messagesOf("package-subpath-escape.txt", rule)).toEqual([expect.stringContaining("dot segments")]);
    expect(messagesOf("package-subpath-dot.txt", rule)).toEqual([expect.stringContaining("dot segments")]);
    expect(messagesOf("alias-percent-encoded.txt", rule)).toEqual([
      expect.stringContaining("dot segments"),
      expect.stringContaining("percent-encoding"),
    ]);
  });

  it("reports every indirect loader and computed access form it can see statically", () => {
    expect(ruleIds("create-require.txt")).toEqual(["no-restricted-imports"]);
    expect(ruleIds("eval-loader.txt")).toEqual(["no-eval"]);
    expect(ruleIds("function-constructor.txt")).toEqual(["no-new-func"]);
    expect(ruleIds("function-via-constructor.txt")).toEqual(["no-restricted-syntax"]);
    expect(ruleIds("require-resolve.txt")).toEqual(["no-restricted-properties", "no-restricted-syntax"]);
    expect(ruleIds("import-meta-resolve.txt")).toEqual(["no-restricted-syntax"]);
    expect(ruleIds("aliased-require.txt")).toEqual(["no-restricted-syntax"]);
    expect(ruleIds("module-require-member.txt")).toEqual(["no-restricted-imports", "no-restricted-syntax"]);
    expect(ruleIds("require-main-require.txt")).toEqual(["no-restricted-syntax"]);
    expect(ruleIds("computed-process-member.txt")).toEqual(["no-restricted-syntax"]);
    expect(ruleIds("computed-globalthis.txt")).toEqual(["no-restricted-syntax"]);
    expect(ruleIds("parenthesized-import-meta.txt")).toEqual(["no-restricted-syntax"]);
    expect(ruleIds("vm-loader.txt")).toEqual(["no-restricted-imports"]);
    expect(ruleIds("worker-threads-loader.txt")).toEqual(["no-restricted-imports"]);
    expect(ruleIds("child-process-loader.txt")).toEqual(["no-restricted-imports"]);
    expect(ruleIds("reflect-get-process.txt")).toEqual(["no-restricted-syntax"]);
  });

  it("fails the reproduced loaders and every runtime-only fixture under the runtime rules", () => {
    expect(ruleIds("runtime:s7-getbuiltinmodule-proxy.txt")).toEqual(["no-restricted-globals", "no-restricted-properties", "no-restricted-syntax"]);
    expect(ruleIds("runtime:s9-evalmanifest-proxy.txt")).toEqual(["no-restricted-imports"]);
    expect(ruleIds("runtime:s9-requirepage-proxy.txt")).toEqual(["no-restricted-imports"]);
    expect(messagesOf("runtime:s9-evalmanifest-proxy.txt", "no-restricted-imports")).toEqual([expect.stringContaining("type-only next/server, type-only next and repository files")]);
    for (const name of [
      "runtime-node-builtin.txt",
      "runtime-dev-package.txt",
      "runtime-next-value-import.txt",
      "runtime-next-default-import.txt",
      "runtime-next-mixed-import.txt",
      "runtime-next-reexport.txt",
      "runtime-next-dist-type.txt",
      "runtime-next-compiled.txt",
      "runtime-react-import.txt",
      "runtime-react-dom-server.txt",
    ]) {
      expect(ruleIds(`runtime:${name}`), name).toEqual(["no-restricted-imports"]);
    }
    expect(ruleIds("runtime:runtime-fetch.txt")).toEqual(["no-restricted-globals"]);
    expect(ruleIds("runtime:runtime-timer.txt")).toEqual(["no-restricted-globals"]);
    expect(ruleIds("runtime:runtime-globalthis.txt")).toEqual(["no-restricted-globals"]);
    expect(ruleIds("runtime:runtime-this.txt")).toEqual(["no-restricted-syntax"]);
    expect(ruleIds("runtime:runtime-computed-destructuring.txt")).toEqual(["no-restricted-syntax"]);
    expect(ruleIds("runtime:computed-module-binding.txt")).toEqual(["no-restricted-imports", "no-restricted-syntax"]);
  });

  it("reports nothing for the clean controls", () => {
    expect(results["clean-module.txt"]).toEqual([]);
    expect(results["runtime:clean-runtime-types.txt"]).toEqual([]);
  });
});
