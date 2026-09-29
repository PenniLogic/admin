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
});

/** Headers that must never appear on any response, denial or otherwise. */
export const FORBIDDEN_HEADER_PATTERN =
  /^(?:set-cookie|location|refresh|x-powered-by|server|www-authenticate|allow|access-control-.*|x-middleware-.*|x-nextjs-.*|admin-.*)$/i;

export function expectNoForbiddenHeaders(names: Iterable<string>): void {
  for (const name of names) {
    expect(name).not.toMatch(FORBIDDEN_HEADER_PATTERN);
  }
}

export function expectDenialHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(EXPECTED_DENIAL_HEADERS)) {
    expect(headers.get(name), name).toBe(value);
  }
  expect(headers.getSetCookie()).toEqual([]);
  expectNoForbiddenHeaders(headers.keys());
}

/**
 * The denial page must stay self-contained and silent about the service, its configuration, any
 * provider, any host and any way to obtain access.
 */
export function expectDenialPage(body: string): void {
  expect(body.startsWith("<!doctype html>\n")).toBe(true);
  expect(body).toContain('<html lang="en">');
  expect(body).toContain("<title>Access denied</title>");
  expect(body).toContain("<main>");
  expect(body).toContain("<h1>Access denied</h1>");
  expect(body).toContain("<p>This service does not accept requests.</p>");
  expect(body.endsWith("</html>\n")).toBe(true);
  expect(body).not.toMatch(
    /<(?:script|style|link|img|iframe|frame|form|input|button|a|code|object|embed|video|audio)\b/i,
  );
  expect(body).not.toMatch(/\bon[a-z]+=/i);
  expect(body).not.toMatch(/\bstyle=/i);
  expect(body).not.toMatch(/https?:\/\//i);
  expect(body).not.toMatch(/\b[a-z0-9-]+\.(?:com|in|app|io|net|org|dev)\b/i);
  expect(body).not.toMatch(/identity|provider|configur|reason|administrat|console|pennilogic|cookie|session|login|sign[ -]?in/i);
}
