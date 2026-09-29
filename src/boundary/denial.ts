import type { Denied } from "@/src/boundary/authorize";

/** Status per decision outcome; an allowed outcome would need a reviewed entry here. */
const STATUS_BY_OUTCOME = Object.freeze({ denied: 403 } as const);

export const DENIAL_STATUS: 403 = STATUS_BY_OUTCOME.denied;

/**
 * Headers sent with every denial. None of them stores anything on the client, none names this
 * service, and the policy forbids every script, style, image, frame and form on the page itself.
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
 * Neutral, self-contained denial document. It says nothing about what the service is, how it is
 * configured or how access could be obtained; the decision reason stays in code and tests. It loads
 * no script, style, link, image or external resource, so it renders identically under the strict
 * policy above and with assistive technology.
 */
export const DENIAL_PAGE: string = [
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
  "<p>This service does not accept requests.</p>",
  "</main>",
  "</body>",
  "</html>",
  "",
].join("\n");

/** Builds the denial for any method; HEAD responses carry the same headers and no body. */
export function denialResponse(decision: Denied, method: string): Response {
  const body = method.toUpperCase() === "HEAD" ? null : DENIAL_PAGE;
  return new Response(body, { status: STATUS_BY_OUTCOME[decision.outcome], headers: new Headers(DENIAL_HEADERS) });
}
