import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const IGNORED = new Set(["node_modules", ".next", ".git", "coverage"]);
const THIS_FILE = path.relative(ROOT, fileURLToPath(import.meta.url));

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

const HOSTNAME = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|in|app|io|net|org|dev|co|xyz|cloud|tech|invalid)\b/gi;

/** Cookie handling of any kind: setting, reading, prefixes and domain scoping. */
const COOKIE_HANDLING = /set-cookie|document\.cookie|\bcookies?\s*\(|\.cookies\b|__host-|__secure-|;\s*domain=|\bcookieStore\b/gi;

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
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

function runtimeFiles(): string[] {
  return relativeFiles().filter((file) => RUNTIME.some((entry) => file === entry || file.startsWith(entry + path.sep)));
}

describe("no customer artifacts", () => {
  it("scans the runtime files it expects", () => {
    expect(runtimeFiles()).toEqual([
      path.join("app", "[[...path]]", "route.ts"),
      "next.config.ts",
      "proxy.ts",
      path.join("src", "boundary", "authorize.ts"),
      path.join("src", "boundary", "denial.ts"),
    ]);
  });

  it("keeps cookies, sessions, storage, environment and network locations out of runtime source", () => {
    for (const file of runtimeFiles()) {
      const source = read(file);
      expect(source, file).not.toMatch(/cookie/i);
      expect(source, file).not.toMatch(/session/i);
      expect(source, file).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      expect(source, file).not.toMatch(/process\.env/);
      expect(source, file).not.toMatch(/https?:\/\//i);
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/bearer|jwt|oauth|oidc|saml|["']authorization["']/i);
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
      const hosts = [...new Set((read(file).match(HOSTNAME) ?? []).map((host) => host.toLowerCase()))];
      expect(hosts.filter((host) => !ALLOWED_HOSTS.has(host)), file).toEqual([]);
    }
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
