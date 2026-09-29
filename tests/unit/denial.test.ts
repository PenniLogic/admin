import { describe, expect, it } from "vitest";

import { authorize } from "@/src/boundary/authorize";
import {
  DENIAL_HEADERS,
  DENIAL_REASON_HEADER,
  DENIAL_STATUS,
  denialResponse,
  renderDenialPage,
} from "@/src/boundary/denial";
import { expectDenialHeaders, expectDenialPage, METHODS } from "../support/denial";

describe("denialResponse", () => {
  it.each(METHODS)("answers %s with 403 and the denial headers", (method) => {
    const response = denialResponse(authorize(), method);
    expect(response.status).toBe(DENIAL_STATUS);
    expect(response.status).toBe(403);
    expectDenialHeaders(response.headers);
  });

  it("sends the denial page for methods with a body", async () => {
    const response = denialResponse(authorize(), "GET");
    const body = await response.text();
    expect(body).toBe(renderDenialPage(authorize()));
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
    expect(DENIAL_HEADERS).not.toHaveProperty(DENIAL_REASON_HEADER);
  });
});

describe("renderDenialPage", () => {
  const page = renderDenialPage(authorize());

  it("is a complete, language-tagged, self-contained document", () => {
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(page).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(page).toContain("<main>");
    expect(page).toContain(
      "This administrative console has no identity provider configured, so every request is refused.",
    );
    expectDenialPage(page);
  });

  it("renders the decision reason and nothing else that is dynamic", () => {
    expect(page.match(/<code>[^<]*<\/code>/g)).toEqual(["<code>no-administrative-identity-provider</code>"]);
    expect(renderDenialPage(authorize())).toBe(page);
  });
});
