import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const IGNORED = new Set(["node_modules", ".next", ".git", "coverage"]);
const THIS_FILE = path.relative(ROOT, fileURLToPath(import.meta.url));
const PINNED_SCHEMA = path.join("quality", "client-state-taxonomy", "client-state-taxonomy.schema.json");
const PINNED_SCHEMA_SHA256 = "6bceee452e135835baa7733886d3aceae6322df5a6aefc0c9ea9f9d35ddebfc1";
const SCHEMA_DOCUMENTATION_URI = '"$schema": "http://json-schema.org/draft-07/schema#"';

/** Runtime source: everything that ships in or configures the server. */
const RUNTIME = ["app", "src", "proxy.ts", "next.config.ts"];

/** Hosts a scaffold legitimately references in tooling, lockfile provenance and documentation. */
const ALLOWED_HOSTS = new Set([
  "github.com",
  "docs.github.com",
  "help.github.com",
  "registry.npmjs.org",
  "www.npmjs.com",
  "nodejs.org",
  "nextjs.org",
  "eslint.org",
  "vitest.dev",
  "typescriptlang.org",
  "www.typescriptlang.org",
  "example.invalid",
]);

/**
 * Hostname tripwire. This is a heuristic with a finite top-level-domain list, chosen to avoid
 * matching file names such as `next.config.ts`; the structural guarantees are the import boundary
 * and the absence of any cookie handling, not this list.
 */
const HOSTNAME =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|in|app|io|net|org|dev|co|xyz|cloud|tech|ai|money|finance|bank|pay|cash|fin|info|biz|me|us|uk|eu|invalid)\b/gi;

/** Cookie handling of any kind: setting, reading, prefixes and domain scoping. */
const COOKIE_HANDLING = /set-cookie|document\.cookie|\bcookies?\s*\(|\.cookies\b|__host-|__secure-|;\s*domain=|\bcookieStore\b/gi;

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    // Links are refused outright: the boundary is lexical and must never be followed elsewhere.
    expect(entry.isSymbolicLink(), `${full} is a symbolic link or junction`).toBe(false);
    if (entry.isDirectory()) {
      if (!IGNORED.has(entry.name)) {
        files.push(...listFiles(full));
      }
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files.sort();
}

function relativeFiles(): string[] {
  return listFiles(ROOT).map((file) => path.relative(ROOT, file));
}

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function unexpectedHosts(file: string, bytes: Buffer): string[] {
  let source = bytes.toString("utf8");
  if (file === PINNED_SCHEMA) {
    if (createHash("sha256").update(bytes).digest("hex") !== PINNED_SCHEMA_SHA256) {
      throw new Error("Pinned taxonomy schema bytes changed");
    }
    source = source.replace(SCHEMA_DOCUMENTATION_URI, '"$schema": ""');
  }
  const hosts = [...new Set((source.match(HOSTNAME) ?? []).map((host) => host.toLowerCase()))];
  return hosts.filter((host) => !ALLOWED_HOSTS.has(host));
}

function runtimeFiles(): string[] {
  return relativeFiles().filter((file) => RUNTIME.some((entry) => file === entry || file.startsWith(entry + path.sep)));
}

describe("no customer artifacts", () => {
  it("scans the runtime files it expects and no Next.js configuration sibling exists", () => {
    expect(runtimeFiles()).toEqual([
      path.join("app", "[[...path]]", "route.ts"),
      "next.config.ts",
      "proxy.ts",
      path.join("src", "boundary", "authorize.ts"),
      path.join("src", "boundary", "denial.ts"),
    ]);
    const rootFiles = readdirSync(ROOT);
    expect(rootFiles.filter((name) => name.startsWith("next.config."))).toEqual(["next.config.ts"]);
    expect(rootFiles.filter((name) => /^(middleware|proxy|instrumentation)\./.test(name))).toEqual(["proxy.ts"]);
  });

  it("keeps cookies, sessions, storage, environment, loaders, process and network locations out of runtime source", () => {
    for (const file of runtimeFiles()) {
      const source = read(file);
      expect(source, file).not.toMatch(/cookie/i);
      expect(source, file).not.toMatch(/session/i);
      expect(source, file).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      expect(source, file).not.toMatch(/\bprocess\b|\bglobalThis\b|\bmodule\b|\brequire\b|\bimport\.meta\b/);
      expect(source, file).not.toMatch(/https?:\/\//i);
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/bearer|jwt|oauth|oidc|saml|["']authorization["']/i);
      expect(source, file).not.toMatch(/createRequire|getBuiltinModule|\beval\b|new Function|require\s*\(|import\s*\(/);
      expect(source, file).not.toMatch(/node:(?:vm|worker_threads|child_process|module|process|fs|net|http|https|dgram|tls|os|repl|inspector)\b/);
      expect(source.match(HOSTNAME) ?? [], file).toEqual([]);
    }
  });

  it("handles no cookie anywhere outside the tests that assert their absence", () => {
    for (const file of relativeFiles()) {
      if (file.startsWith("tests" + path.sep)) {
        continue;
      }
      expect(read(file).match(COOKIE_HANDLING) ?? [], file).toEqual([]);
    }
  });

  it("names no hostname other than tooling and documentation hosts anywhere in the repository", () => {
    for (const file of relativeFiles()) {
      if (file === THIS_FILE || file === "package-lock.json") {
        continue;
      }
      expect(unexpectedHosts(file, readFileSync(path.join(ROOT, file))), file).toEqual([]);
    }
  });

  it("exempts only the immutable schema's literal documentation URI", () => {
    expect(unexpectedHosts(PINNED_SCHEMA, readFileSync(path.join(ROOT, PINNED_SCHEMA)))).toEqual([]);
  });

  it.each([
    path.join("quality", "other.schema.json"),
    path.join("tools", "planted.mjs"),
    path.join("src", "boundary", "authorize.ts"),
  ])("still rejects the documentation hostname in another file: %s", (file) => {
    expect(unexpectedHosts(file, Buffer.from(SCHEMA_DOCUMENTATION_URI))).toEqual(["json-schema.org"]);
  });

  it("rejects altered pinned schema bytes even when its hostname list is unchanged", () => {
    const bytes = readFileSync(path.join(ROOT, PINNED_SCHEMA));
    expect(() => unexpectedHosts(PINNED_SCHEMA, Buffer.concat([bytes, Buffer.from("\n")])))
      .toThrow("Pinned taxonomy schema bytes changed");
  });

  it("rejects a network hostname added anywhere in the pinned schema", () => {
    const source = read(PINNED_SCHEMA).replace('"title":', '"network": "https://runtime-network.invalid", "title":');
    expect(() => unexpectedHosts(PINNED_SCHEMA, Buffer.from(source))).toThrow("Pinned taxonomy schema bytes changed");
  });

  it("still rejects a network hostname in runtime source", () => {
    expect(unexpectedHosts(path.join("src", "boundary", "authorize.ts"), Buffer.from('fetch("https://runtime-network.invalid")')))
      .toEqual(["runtime-network.invalid"]);
  });

  it("resolves every locked package from the public registry and nothing else", () => {
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { resolved?: string }> };
    const hosts = new Set<string>();
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key !== "") {
        hosts.add(new URL(entry.resolved ?? "invalid:").host);
      }
    }
    expect([...hosts]).toEqual(["registry.npmjs.org"]);
  });

  it("ships no fixtures resembling customer data", () => {
    const fixtures = relativeFiles().filter((file) => file.startsWith("tests" + path.sep + "fixtures" + path.sep));
    expect(fixtures.length).toBeGreaterThan(0);
    for (const file of fixtures) {
      expect(file.endsWith(".txt"), file).toBe(true);
      expect(file.startsWith(path.join("tests", "fixtures", "import-boundary")), file).toBe(true);
      const content = read(file);
      expect(content, file).not.toMatch(/\d{4,}/);
      expect(content, file).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
      expect(content, file).not.toMatch(/salary|debt|balance|transaction|account|upi|ifsc|pan\b|aadhaar|phone|email|₹|inr/i);
    }
  });
});
