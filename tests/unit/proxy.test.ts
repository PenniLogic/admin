import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import * as proxyModule from "@/proxy";
import { proxy } from "@/proxy";
import { expectDenialHeaders, expectDenialPage, METHODS } from "../support/denial";

const PATHS = [
  "/",
  "/admin",
  "/admin/login",
  "/api/admin/users",
  "/api/customers",
  "/_next/static/chunks/main.js",
  "/_next/image?url=%2Fx.png&w=64&q=75",
  "/favicon.ico",
  "/.env",
  "/health",
  "/%2e%2e/%2e%2e/etc/passwd",
];

describe("proxy", () => {
  it("exports no matcher, so it runs for every path", () => {
    expect(Object.keys(proxyModule).sort()).toEqual(["proxy"]);
    expect("config" in proxyModule).toBe(false);
  });

  it.each(METHODS)("denies %s on every path", async (method) => {
    for (const path of PATHS) {
      const request = new NextRequest(new URL(path, "http://localhost"), {
        method,
        headers: { cookie: "anything=ignored", authorization: "Bearer ignored" },
      });
      const response = proxy(request);
      expect(response.status, `${method} ${path}`).toBe(403);
      expectDenialHeaders(response.headers);
      if (method === "HEAD") {
        expect(response.body).toBeNull();
      } else {
        expectDenialPage(await response.text());
      }
    }
  });

  it("returns a plain denial rather than rewriting, redirecting or continuing", () => {
    const response = proxy(new NextRequest("http://localhost/"));
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.headers.get("x-middleware-override-headers")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
  });
});
