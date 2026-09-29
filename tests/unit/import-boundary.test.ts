import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  ALLOWED_ORGANIZATION_PACKAGES,
  organizationRuleFor,
  packageNameOf,
  RESTRICTED_IMPORT_PATTERNS,
  RULES,
} from "@/tools/import-boundary/policy.mjs";
import {
  checkLockfile,
  checkManifest,
  checkSource,
  checkSpecifier,
  declaredDependencies,
  extractNonLiteralSpecifiers,
  extractSpecifiers,
  IGNORED_DIRECTORIES,
  listSourceFiles,
  scanRepository,
  SOURCE_EXTENSIONS,
} from "@/tools/import-boundary/scan.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "import-boundary");
const CHECK_CLI = path.join(ROOT, "tools", "import-boundary", "check.mjs");

type Manifest = Parameters<typeof checkManifest>[0];
type Lockfile = Parameters<typeof checkLockfile>[0];

const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as Manifest;
const lockfile = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as Lockfile;
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
  "template-dynamic-import.txt": RULES.nonLiteralSpecifier,
  "variable-require.txt": RULES.nonLiteralSpecifier,
  "require-call.txt": RULES.organizationPackage,
  "relative-escape.txt": RULES.escapesRepository,
  "deep-relative-escape.txt": RULES.escapesRepository,
  "alias-escape.txt": RULES.escapesRepository,
  "absolute-path.txt": RULES.absoluteOrRemote,
  "remote-url.txt": RULES.absoluteOrRemote,
  "undeclared-package.txt": RULES.undeclaredDependency,
};
const CONTROLS = ["clean-source.txt", "clean-module.txt"];

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

/** Copies manifest and lockfile into a throwaway root so a planted file can be scanned end to end. */
function plantedRepository(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "admin-import-boundary-"));
  cpSync(path.join(ROOT, "package.json"), path.join(root, "package.json"));
  cpSync(path.join(ROOT, "package-lock.json"), path.join(root, "package-lock.json"));
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

describe("import boundary of the real repository", () => {
  it("finds no violation in the manifest, lockfile or any source file", () => {
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

  it("passes the command-line check", () => {
    const run = spawnSync(process.execPath, [CHECK_CLI], { cwd: ROOT, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^Import boundary intact: \d+ source files, manifest and lockfile checked\.\n$/);
  });
});

describe("planted forbidden imports", () => {
  it("covers every fixture exactly once", () => {
    expect(readdirSync(FIXTURES).sort()).toEqual([...Object.keys(PLANTED), ...CONTROLS].sort());
  });

  it.each(Object.entries(PLANTED))("%s is refused by rule %s", (name, rule) => {
    const violations = checkSource(fixture(name), path.join(ROOT, "src", "planted.ts"), context);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.rule)).toContain(rule);
    for (const violation of violations) {
      expect(violation.file).toBe(path.join("src", "planted.ts"));
      expect(violation.specifier.length).toBeGreaterThan(0);
      expect(violation.message.length).toBeGreaterThan(0);
    }
  });

  it.each(CONTROLS)("%s passes as a clean control", (name) => {
    expect(checkSource(fixture(name), path.join(ROOT, "tests", "unit", "control.ts"), context)).toEqual([]);
  });

  it("fails a repository scan and the command-line check when planted as a real file", () => {
    withPlantedRepository({ "src/planted.ts": fixture("customer-web-package.txt") }, (root) => {
      const result = scanRepository(root);
      expect(result.violations.map((violation) => [violation.rule, violation.file])).toEqual([
        [RULES.organizationPackage, path.join("src", "planted.ts")],
      ]);
      const run = spawnSync(process.execPath, [CHECK_CLI, "--root", root], { cwd: ROOT, encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        `${RULES.organizationPackage}: ${path.join("src", "planted.ts")} -> @pennilogic/web/session`,
      );
      expect(run.stderr).toContain("Import boundary violated: 1 finding(s)");
      expect(run.stdout).toBe("");
    });
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
    expect(extractNonLiteralSpecifiers(fixture("clean-source.txt"))).toEqual([]);
  });

  it("extracts non-literal dynamic arguments and refuses template placeholders", () => {
    expect(extractNonLiteralSpecifiers(fixture("variable-require.txt"))).toEqual(["name"]);
    expect(extractNonLiteralSpecifiers(fixture("template-dynamic-import.txt"))).toEqual([]);
    expect(extractSpecifiers(fixture("template-dynamic-import.txt"))).toEqual(["@pennilogic/${target}"]);
    expect(checkSpecifier("@pennilogic/${target}", file, context)?.rule).toBe(RULES.nonLiteralSpecifier);
    expect(checkSpecifier("./${name}", file, context)?.rule).toBe(RULES.nonLiteralSpecifier);
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

  it("refuses organization packages, customer names, escapes, absolute and remote specifiers, and undeclared packages", () => {
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
  });

  it("derives package names from scoped and unscoped specifiers", () => {
    expect(packageNameOf("next/server")).toBe("next");
    expect(packageNameOf("@eslint/js/flat")).toBe("@eslint/js");
    expect(packageNameOf("lonely")).toBe("lonely");
  });
});

describe("manifest and lockfile provenance", () => {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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

  it("refuses workspaces, bundled dependencies and overrides", () => {
    const planted = {
      ...clone(manifest),
      workspaces: ["../web"],
      bundleDependencies: ["x"],
      bundledDependencies: ["y"],
      overrides: {},
    };
    const violations = checkManifest(planted);
    expect(violations.map((violation) => violation.specifier).sort()).toEqual([
      "bundleDependencies",
      "bundledDependencies",
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
      const files = listSourceFiles(root).map((file) => path.relative(root, file));
      expect(files).toHaveLength(SOURCE_EXTENSIONS.length);
      expect(files.every((file) => file.startsWith(path.join("nested", "deeper")))).toBe(true);
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

  function restrictedMessages(name: string): string[] {
    const messages = results[name] ?? [];
    expect(messages.filter((message) => message.fatal)).toEqual([]);
    const restricted = messages.filter((message) => message.ruleId === "no-restricted-imports");
    expect(restricted.every((message) => message.severity === 2)).toBe(true);
    return restricted.map((message) => message.message);
  }

  it("configures no-restricted-imports as an error for TypeScript, TSX and module JavaScript files", () => {
    for (const file of configFiles) {
      expect(configs[file], file).toEqual([2, { patterns: [...RESTRICTED_IMPORT_PATTERNS] }]);
    }
  });

  it("reports planted organization, customer, prefixed and remote static imports", () => {
    expect(restrictedMessages("customer-web-package.txt")).toEqual([
      expect.stringContaining("PenniLogic packages are refused"),
    ]);
    expect(restrictedMessages("shared-client-bundle.txt")).toEqual([
      expect.stringContaining("Customer web code and shared client bundles"),
      expect.stringContaining("PenniLogic packages are refused"),
    ]);
    expect(restrictedMessages("customer-web-literal.txt")).toEqual([
      expect.stringContaining("Customer web code and shared client bundles"),
    ]);
    expect(restrictedMessages("unscoped-prefix.txt")).toEqual([
      expect.stringContaining("PenniLogic packages are refused"),
    ]);
    expect(restrictedMessages("remote-url.txt")).toEqual([expect.stringContaining("Import only repository files")]);
    expect(restrictedMessages("absolute-path.txt")).toEqual([expect.stringContaining("Import only repository files")]);
  });

  it("reports nothing for the clean module control", () => {
    expect(restrictedMessages("clean-module.txt")).toEqual([]);
    expect(results["clean-module.txt"]).toEqual([]);
  });
});
