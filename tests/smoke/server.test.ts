import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectDenialHeaders, expectDenialPage, expectNoForbiddenHeaders, METHODS } from "../support/denial";
import { rawRequest } from "../support/raw-http";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
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

/** Output the framework must never print while serving forwarded requests. */
const FRAMEWORK_NOISE = /error|unhandled|warn|⚠|deprecat|TypeError/i;

let server: ChildProcess | undefined;
let origin = "";
let port = 0;
let serverOutput = "";
/** Length of the server output once every forwarded-request test has run. */
let forwardedOutputLength = 0;

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

function raw(request: string, settleMs?: number) {
  return rawRequest(HOST, port, request.replaceAll("\n", "\r\n"), settleMs);
}

beforeAll(async () => {
  const buildId = path.join(ROOT, ".next", "BUILD_ID");
  if (!existsSync(buildId)) {
    throw new Error("Run `npm run build` before `npm run smoke`; the smoke test exercises the production build.");
  }
  port = await freePort();
  origin = `http://${HOST}:${String(port)}`;
  server = spawn(process.execPath, [NEXT_BIN, "start", "-H", HOST, "-p", String(port)], {
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

describe("forwarded requests", () => {
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

  it("logs nothing noisy or request-identifying while serving denials", () => {
    forwardedOutputLength = serverOutput.length;
    expect(serverOutput).toMatch(/Ready in/);
    expect(serverOutput).not.toMatch(/cookie|authorization|bearer/i);
    expect(serverOutput).not.toMatch(FRAMEWORK_NOISE);
  });
});

/**
 * Requests the framework answers on its own, before proxy.ts runs. None of these is a denial, none
 * sets a cookie or serves content, and none can be changed from application code; the deployment
 * edge must reject them (docs/scaffold.md). They are pinned so a framework change is noticed.
 */
describe("requests answered by the framework before the boundary", () => {
  it("collapses repeated leading slashes to the same origin with a 308, then denies", async () => {
    const redirect = await fetch(`${origin}//double`, { redirect: "manual" });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/double");
    expect(redirect.headers.getSetCookie()).toEqual([]);
    const denied = await fetch(`${origin}/double`, { redirect: "manual" });
    expect(denied.status).toBe(403);
    expectDenialHeaders(denied.headers);
  });

  it("answers TRACE with a framework 500 and no content, and logs the framework error without request headers", async () => {
    const before = serverOutput.length;
    const response = await raw(`TRACE /admin HTTP/1.1\nHost: ${HOST}:${String(port)}\nCookie: planted=marker\nConnection: close\n\n`);
    expect(response.status).toBe(500);
    expect(response.body.trim()).toBe("Internal Server Error");
    expect(response.headers.has("set-cookie")).toBe(false);
    expectNoForbiddenHeaders(response.headers.keys());
    await new Promise((resolve) => setTimeout(resolve, 250));
    const logged = serverOutput.slice(before);
    expect(logged).toMatch(/TypeError/);
    expect(logged).not.toMatch(/planted=marker|cookie:/i);
  });

  it("answers an asterisk-form target with a framework 500 and no content", async () => {
    const response = await raw(`OPTIONS * HTTP/1.1\nHost: ${HOST}:${String(port)}\nConnection: close\n\n`);
    expect(response.status).toBe(500);
    expect(response.body.trim()).toBe("Internal Server Error");
    expect(response.headers.has("set-cookie")).toBe(false);
    expectNoForbiddenHeaders(response.headers.keys());
  });

  it("re-emits an absolute-form target as a 308 to the supplied URL without setting anything", async () => {
    const response = await raw(`GET https://example.invalid/x HTTP/1.1\nHost: ${HOST}:${String(port)}\nConnection: close\n\n`);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toEqual(["https://example.invalid/x"]);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  it("holds an Upgrade request open without answering; the test closes it", async () => {
    const response = await raw(
      `GET / HTTP/1.1\nHost: ${HOST}:${String(port)}\nConnection: Upgrade\nUpgrade: websocket\nSec-WebSocket-Version: 13\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\n\n`,
      1500,
    );
    expect(response.raw).toBe("");
    expect(response.status).toBeNull();
  });

  it("logged nothing about the forwarded requests and no request-identifying text at all", () => {
    expect(serverOutput.slice(0, forwardedOutputLength)).not.toMatch(FRAMEWORK_NOISE);
    expect(serverOutput).not.toMatch(/cookie|authorization|bearer|planted/i);
  });
});
