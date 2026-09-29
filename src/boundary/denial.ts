import type { Denied } from "@/src/boundary/authorize";

export const DENIAL_STATUS = 403;

/** Header carrying the machine-readable reason so callers can tell this denial from an upstream 403. */
export const DENIAL_REASON_HEADER = "admin-denial-reason";

/**
 * Headers sent with every denial. None of them stores anything on the client, and the policy
 * forbids every script, style, image, frame and form on the denial page itself.
 */
export const DENIAL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
});

/**
 * Self-contained denial document: no scripts, styles, links, images or external resources, so it
 * renders identically under the strict policy above and with assistive technology.
 */
export function renderDenialPage(decision: Denied): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    "<title>Access denied</title>",
    "</head>",
    "<body>",
    "<main>",
    "<h1>Access denied</h1>",
    "<p>This administrative console has no identity provider configured, so every request is refused.</p>",
    `<p>Reason code: <code>${decision.reason}</code></p>`,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Builds the denial for any method; HEAD responses carry the same headers and no body. */
export function denialResponse(decision: Denied, method: string): Response {
  const headers = new Headers(DENIAL_HEADERS);
  headers.set(DENIAL_REASON_HEADER, decision.reason);
  const body = method.toUpperCase() === "HEAD" ? null : renderDenialPage(decision);
  return new Response(body, { status: DENIAL_STATUS, headers });
}
