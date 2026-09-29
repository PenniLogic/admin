import { describe, expect, it } from "vitest";

import { authorize } from "@/src/boundary/authorize";
import { DENIAL_HEADERS, DENIAL_PAGE, DENIAL_STATUS, denialResponse } from "@/src/boundary/denial";
import { EXPECTED_DENIAL_HEADERS, expectDenialHeaders, expectDenialPage, METHODS } from "../support/denial";

describe("denialResponse", () => {
  it.each(METHODS)("answers %s with 403 and exactly the denial headers", (method) => {
    const response = denialResponse(authorize(), method);
    expect(response.status).toBe(DENIAL_STATUS);
    expect(response.status).toBe(403);
    expectDenialHeaders(response.headers);
    expect([...response.headers.keys()].sort()).toEqual(Object.keys(EXPECTED_DENIAL_HEADERS).sort());
  });

  it("sends the denial page for methods with a body", async () => {
    const response = denialResponse(authorize(), "GET");
    const body = await response.text();
    expect(body).toBe(DENIAL_PAGE);
    expectDenialPage(body);
  });

  it("sends no body for HEAD, case-insensitively, while keeping the headers", async () => {
    for (const method of ["HEAD", "head", "Head"]) {
      const response = denialResponse(authorize(), method);
      expect(response.body).toBeNull();
      expect(await response.text()).toBe("");
      expectDenialHeaders(response.headers);
    }
  });

  it("builds fresh headers for every response from a frozen template", () => {
    const first = denialResponse(authorize(), "GET");
    first.headers.set("cache-control", "public");
    const second = denialResponse(authorize(), "GET");
    expect(second.headers.get("cache-control")).toBe("no-store");
    expect(Object.isFrozen(DENIAL_HEADERS)).toBe(true);
    expect(DENIAL_HEADERS).toEqual(EXPECTED_DENIAL_HEADERS);
  });

  it("derives the status from the decision outcome alone", () => {
    const decision = authorize();
    expect(denialResponse({ outcome: decision.outcome, reason: decision.reason }, "GET").status).toBe(403);
  });
});

describe("DENIAL_PAGE", () => {
  it("is a complete, language-tagged, self-contained document", () => {
    expect(DENIAL_PAGE).toContain('<meta charset="utf-8">');
    expect(DENIAL_PAGE).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(DENIAL_PAGE).toContain('<meta name="robots" content="noindex, nofollow">');
    expectDenialPage(DENIAL_PAGE);
  });

  it("carries no dynamic content and no decision reason", () => {
    expect(DENIAL_PAGE).not.toContain(authorize().reason);
    expect(DENIAL_PAGE.match(/<p>[^<]*<\/p>/g)).toEqual(["<p>This service does not accept requests.</p>"]);
    expect(DENIAL_PAGE.match(/<h1>[^<]*<\/h1>/g)).toEqual(["<h1>Access denied</h1>"]);
  });
});
