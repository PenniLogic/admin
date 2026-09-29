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
  NEXT_CONFIG_ALLOWED_KEYS,
  organizationRuleFor,
  packageNameOf,
  RESTRICTED_IMPORT_PATHS,
  RESTRICTED_IMPORT_PATTERNS,
  RULES,
  TSCONFIG_PINNED_PATHS,
} from "@/tools/import-boundary/policy.mjs";
import {
  canonical,
  checkLockfile,
  checkManifest,
  checkNextConfig,
  checkSource,
  checkSpecifier,
  checkTsconfig,
  declaredDependencies,
  extractSpecifiers,
  IGNORED_DIRECTORIES,
  listSourceFiles,
  parseImports,
  scanRepository,
  SOURCE_EXTENSIONS,
} from "@/tools/import-boundary/scan.mjs";
import vitestConfig from "@/vitest.config.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "import-boundary");
const CHECK_CLI = path.join(ROOT, "tools", "import-boundary", "check.mjs");
const COPIED_INTO_PLANTED_ROOTS = ["package.json", "package-lock.json", "tsconfig.json", "next.config.ts"];

type Manifest = Parameters<typeof checkManifest>[0];
type Lockfile = Parameters<typeof checkLockfile>[0];

const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as Manifest;
const lockfile = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as Lockfile;
const tsconfig = JSON.parse(readFileSync(path.join(ROOT, "tsconfig.json"), "utf8")) as Record<string, unknown>;
const nextConfigSource = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
const context = { root: ROOT, declared: declaredDependencies(manifest) };

/**
 * Planted sources live in .txt fixtures, never inline in a scanned source file, and each names the
 * rule it must trip. The two clean controls must pass.
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
  "require-resolve.txt": RULES.indirectLoader,
  "import-meta-resolve.txt": RULES.indirectLoader,
  "relative-escape.txt": RULES.escapesRepository,
  "deep-relative-escape.txt": RULES.escapesRepository,
  "alias-escape.txt": RULES.escapesRepository,
  "triple-slash-reference.txt": RULES.escapesRepository,
  "absolute-path.txt": RULES.absoluteOrRemote,
  "remote-url.txt": RULES.absoluteOrRemote,
  "subpath-import.txt": RULES.absoluteOrRemote,
  "undeclared-package.txt": RULES.undeclaredDependency,
};
/** A comment inside the call does not hide a literal specifier; the package rule still applies. */
const PLANTED_WITH_COMMENT = { "commented-dynamic-import.txt": RULES.organizationPackage };
const CONTROLS = ["clean-source.txt", "clean-module.txt"];

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
    expect(TSCONFIG_PINNED_PATHS).toEqual({ "@/*": ["./*"] });
    const alias = vitestConfig.resolve?.alias as readonly { find: RegExp | string; replacement: string }[] | undefined;
    expect(alias).toHaveLength(1);
    expect(alias?.[0]?.find).toEqual(/^@\//);
    expect(path.resolve(alias?.[0]?.replacement ?? "")).toBe(ROOT);
    expect(vitestConfig.resolve?.preserveSymlinks).toBeUndefined();
    expect(vitestConfig.server).toBeUndefined();
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
      [...Object.keys(PLANTED), ...Object.keys(PLANTED_WITH_COMMENT), ...CONTROLS].sort(),
    );
  });

  it.each([...Object.entries(PLANTED), ...Object.entries(PLANTED_WITH_COMMENT)])(
    "%s is refused by rule %s",
    (name, rule) => {
      const violations = checkSource(fixture(name), path.join(ROOT, "src", "planted.ts"), context);
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

  it.each(CONTROLS)("%s passes as a clean control", (name) => {
    expect(checkSource(fixture(name), path.join(ROOT, "tests", "unit", "control.ts"), context)).toEqual([]);
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
    for (const name of ["concatenated-dynamic-import.txt", "create-require.txt"]) {
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

  it("stays inside the repository when the same hops do not reach the root", () => {
    withPlantedRepository({ "app/(admin)/nested/page.tsx": fixture("relative-escape.txt") }, (root) => {
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
    const parsed = parseImports(fixture("clean-source.txt"), "clean.ts");
    expect(parsed.nonLiteral).toEqual([]);
    expect(parsed.loaders).toEqual([]);
    expect(parsed.specifiers.map((entry) => entry.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("reports every dynamic call that is not exactly one string literal, with its line", () => {
    expect(parseImports(fixture("variable-require.txt"), "planted.ts").nonLiteral).toEqual([
      { specifier: "require(name)", line: 2 },
    ]);
    expect(parseImports(fixture("template-dynamic-import.txt"), "planted.ts").nonLiteral).toEqual([
      { specifier: "import(`@pennilogic/${target}`)", line: 4 },
    ]);
    expect(parseImports(fixture("concatenated-dynamic-import.txt"), "planted.ts").nonLiteral).toEqual([
      { specifier: 'import("@penni" + "logic/web/session")', line: 1 },
    ]);
    expect(parseImports(fixture("two-argument-dynamic-import.txt"), "planted.ts").nonLiteral).toEqual([
      { specifier: 'import("@pennilogic/web", { with: { type: "json" } })', line: 1 },
    ]);
    expect(parseImports(fixture("commented-dynamic-import.txt"), "planted.ts").specifiers).toEqual([
      { specifier: "@pennilogic/web", line: 1 },
    ]);
  });

  it("reports indirect loaders wherever they appear", () => {
    expect(parseImports(fixture("create-require.txt"), "planted.ts").loaders.map((entry) => entry.specifier)).toEqual([
      "createRequire",
      "createRequire",
    ]);
    expect(parseImports(fixture("module-create-require.txt"), "planted.ts").loaders).toEqual([
      { specifier: "createRequire", line: 3 },
    ]);
    expect(parseImports(fixture("eval-loader.txt"), "planted.ts").loaders).toEqual([{ specifier: "eval", line: 1 }]);
    expect(parseImports(fixture("function-constructor.txt"), "planted.ts").loaders.map((entry) => entry.specifier)).toEqual(
      ["new Function", "Function"],
    );
    expect(parseImports(fixture("require-resolve.txt"), "planted.ts").loaders).toEqual([
      { specifier: "require.resolve", line: 1 },
    ]);
    expect(parseImports(fixture("import-meta-resolve.txt"), "planted.ts").loaders).toEqual([
      { specifier: "import.meta.resolve", line: 1 },
    ]);
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

  it("accepts builtins, declared packages and their subpaths, and in-repository paths", () => {
    const accepted = [
      "node:fs",
      "fs",
      "path",
      "next",
      "next/server",
      "vitest/config",
      "@eslint/js",
      "typescript",
      "./denial",
      "../boundary/authorize",
      "../../tests/support/denial",
      "@/proxy",
      "@/app/[[...path]]/route",
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
      expect(scanRepository(root).violations.map((violation) => violation.specifier)).toEqual(["tsconfig.json"]);
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
  const configFiles = ["src/planted.ts", "app/planted/page.tsx", "proxy.ts", "tools/planted.mjs"];
  const linted = [
    "customer-web-package.txt",
    "shared-client-bundle.txt",
    "customer-web-literal.txt",
    "unscoped-prefix.txt",
    "remote-url.txt",
    "absolute-path.txt",
    "subpath-import.txt",
    "create-require.txt",
    "eval-loader.txt",
    "function-constructor.txt",
    "require-resolve.txt",
    "import-meta-resolve.txt",
    "clean-module.txt",
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
        lint: linted.map((name) => ({ name, filePath: "tools/planted.mjs", source: fixture(name) })),
      }),
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    ({ configs, results } = JSON.parse(run.stdout) as { configs: typeof configs; results: typeof results });
  });

  function messagesOf(name: string, ruleIds: string[]): string[] {
    const messages = results[name] ?? [];
    expect(messages.filter((message) => message.fatal)).toEqual([]);
    const matching = messages.filter((message) => message.ruleId !== null && ruleIds.includes(message.ruleId));
    expect(matching.every((message) => message.severity === 2)).toBe(true);
    return matching.map((message) => `${String(message.ruleId)}: ${message.message}`);
  }

  it("configures no-restricted-imports as an error for TypeScript, TSX and module JavaScript files", () => {
    for (const file of configFiles) {
      expect(configs[file], file).toEqual([
        2,
        { patterns: [...RESTRICTED_IMPORT_PATTERNS], paths: [...RESTRICTED_IMPORT_PATHS] },
      ]);
    }
  });

  it("reports planted organization, customer, prefixed, remote and subpath static imports", () => {
    const rule = ["no-restricted-imports"];
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
  });

  it("reports the indirect loaders it can see statically", () => {
    expect(messagesOf("create-require.txt", ["no-restricted-imports"])).toEqual([expect.stringContaining("createRequire assembles specifiers")]);
    expect(messagesOf("eval-loader.txt", ["no-eval"])).toEqual([expect.stringContaining("eval")]);
    expect(messagesOf("function-constructor.txt", ["no-new-func"])).toEqual([expect.stringContaining("Function constructor")]);
    expect(messagesOf("require-resolve.txt", ["no-restricted-properties"])).toEqual([expect.stringContaining("never resolved at run time")]);
    expect(messagesOf("import-meta-resolve.txt", ["no-restricted-syntax"])).toEqual([expect.stringContaining("import.meta.resolve")]);
  });

  it("reports nothing for the clean module control", () => {
    expect(results["clean-module.txt"]).toEqual([]);
  });
});
