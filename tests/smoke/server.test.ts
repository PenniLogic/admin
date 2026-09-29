import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectDenialHeaders, expectDenialPage, METHODS } from "../support/denial";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const HOST = "127.0.0.1";
const PATHS = [
  "/",
  "/admin",
  "/admin/",
  "/ADMIN",
  "/admin/login",
  "/api/admin/users",
  "/api/admin/users/",
  "/api/customers/1",
  "/_next/static/chunks/main.js",
  "/_next/image?url=%2Fx.png&w=64&q=75",
  "/_next/data/build/index.json",
  "/_not-found",
  "/index",
  "/index.html",
  "/favicon.ico",
  "/robots.txt",
  "/.env",
  "/health",
  "/%2e%2e/%2e%2e/etc/passwd",
  "/deeply/nested/path/that/does/not/exist",
  "/?redirect=%2Fadmin",
];

let server: ChildProcess | undefined;
let origin = "";
let serverOutput = "";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("No TCP port was assigned."));
        return;
      }
      probe.close(() => {
        resolve(address.port);
      });
    });
  });
}

async function waitUntilListening(url: string, attempts: number): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Server exited early with code ${String(server.exitCode)}:\n${serverOutput}`);
    }
    try {
      await fetch(url, { method: "HEAD", redirect: "manual" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Server did not start listening at ${url}:\n${serverOutput}`);
}

beforeAll(async () => {
  const buildId = path.join(ROOT, ".next", "BUILD_ID");
  if (!existsSync(buildId)) {
    throw new Error("Run `npm run build` before `npm run smoke`; the smoke test exercises the production build.");
  }
  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const port = await freePort();
  origin = `http://${HOST}:${String(port)}`;
  server = spawn(process.execPath, [nextBin, "start", "-H", HOST, "-p", String(port)], {
    cwd: ROOT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => {
    serverOutput += chunk.toString();
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    serverOutput += chunk.toString();
  });
  await waitUntilListening(`${origin}/`, 240);
  // Record the exercised build so the evidence names it.
  console.log(`Smoke test against build ${readFileSync(buildId, "utf8").trim()} at ${origin}`);
});

afterAll(async () => {
  const running = server;
  if (running?.exitCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    running.once("exit", () => {
      resolve();
    });
  });
  running.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
});

describe("production server", () => {
  it.each(METHODS)("denies %s on every path", async (method) => {
    for (const requestPath of PATHS) {
      const response = await fetch(`${origin}${requestPath}`, {
        method,
        redirect: "manual",
        headers: {
          cookie: "anything=ignored",
          authorization: "Bearer ignored",
          accept: "text/html,application/json",
        },
      });
      expect(response.status, `${method} ${requestPath}`).toBe(403);
      expectDenialHeaders(response.headers);
      const body = await response.text();
      if (method === "HEAD") {
        expect(body).toBe("");
      } else {
        expectDenialPage(body);
      }
    }
  });

  it("denies with a body for non-HEAD methods and streams nothing else", async () => {
    const response = await fetch(`${origin}/`, { method: "POST", body: "payload", redirect: "manual" });
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expectDenialPage(await response.text());
  });

  it("denies non-standard methods before routing can answer 405", async () => {
    for (const method of ["PROPFIND", "PURGE", "QUERY", "MKCOL"]) {
      const response = await fetch(`${origin}/admin`, { method, redirect: "manual" });
      expect(response.status, method).toBe(403);
      expectDenialHeaders(response.headers);
      expectDenialPage(await response.text());
    }
  });

  it("never issues a redirect, cookie or powered-by header", async () => {
    const response = await fetch(`${origin}/admin/`, { redirect: "manual" });
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("x-powered-by")).toBeNull();
  });

  it("collapses repeated leading slashes to the same origin before denying (framework hardening)", async () => {
    // Next.js normalizes `//path` itself so it can never be read as a protocol-relative host.
    const redirect = await fetch(`${origin}//double`, { redirect: "manual" });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/double");
    expect(redirect.headers.getSetCookie()).toEqual([]);
    const denied = await fetch(`${origin}/double`, { redirect: "manual" });
    expect(denied.status).toBe(403);
    expectDenialHeaders(denied.headers);
  });

  it("denies built static assets and the image optimizer even though the files exist", async () => {
    const staticRoot = path.join(ROOT, ".next", "static");
    const asset = readdirSync(staticRoot, { recursive: true, withFileTypes: true }).find(
      (entry) => entry.isFile() && entry.name.endsWith(".js"),
    );
    expect(asset).toBeDefined();
    const relative = path.relative(staticRoot, path.join(asset?.parentPath ?? staticRoot, asset?.name ?? "")).split(path.sep).join("/");
    const buildId = readFileSync(path.join(ROOT, ".next", "BUILD_ID"), "utf8").trim();
    for (const requestPath of [
      `/_next/static/${relative}`,
      `/_next/static/${buildId}/_buildManifest.js`,
      `/_next/image?url=${encodeURIComponent(`/_next/static/${relative}`)}&w=64&q=75`,
    ]) {
      const response = await fetch(`${origin}${requestPath}`, { redirect: "manual" });
      expect(response.status, requestPath).toBe(403);
      expectDenialHeaders(response.headers);
    }
  });

  it("logs no request-identifying output while serving denials", () => {
    expect(serverOutput).not.toMatch(/cookie|authorization|bearer/i);
    expect(serverOutput).not.toMatch(/error|unhandled|warn/i);
  });
});
