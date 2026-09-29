import { expect } from "vitest";

export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export type Method = (typeof METHODS)[number];

/** Exact header set every denial must carry; shared by the unit tests and the real-server smoke test. */
export const EXPECTED_DENIAL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "admin-denial-reason": "no-administrative-identity-provider",
});

export function expectDenialHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(EXPECTED_DENIAL_HEADERS)) {
    expect(headers.get(name), name).toBe(value);
  }
  expect(headers.getSetCookie()).toEqual([]);
  expect(headers.get("set-cookie")).toBeNull();
  expect(headers.get("location")).toBeNull();
  expect(headers.get("www-authenticate")).toBeNull();
  expect(headers.get("x-powered-by")).toBeNull();
}

/** The denial page must stay self-contained and silent about providers, hosts and customer surfaces. */
export function expectDenialPage(body: string): void {
  expect(body.startsWith("<!doctype html>\n")).toBe(true);
  expect(body).toContain('<html lang="en">');
  expect(body).toContain("<title>Access denied</title>");
  expect(body).toContain("<h1>Access denied</h1>");
  expect(body).toContain("<code>no-administrative-identity-provider</code>");
  expect(body.endsWith("</html>\n")).toBe(true);
  expect(body).not.toMatch(
    /<(?:script|style|link|img|iframe|frame|form|input|button|a|object|embed|video|audio)\b/i,
  );
  expect(body).not.toMatch(/\bon[a-z]+=/i);
  expect(body).not.toMatch(/\bstyle=/i);
  expect(body).not.toMatch(/https?:\/\//i);
  expect(body).not.toMatch(/\b[a-z0-9-]+\.(?:com|in|app|io|net|org|dev)\b/i);
  expect(body).not.toMatch(/cookie|session|login|sign in|sign-in/i);
}
