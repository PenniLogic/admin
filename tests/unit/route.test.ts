import { describe, expect, it } from "vitest";

import * as route from "@/app/[[...path]]/route";
import { expectDenialHeaders, expectDenialPage, METHODS } from "../support/denial";

type Handler = (request: Request) => Response;

describe("catch-all route", () => {
  it("is dynamic and exports exactly one handler per supported method", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(Object.keys(route).sort()).toEqual([...METHODS, "dynamic"].sort());
  });

  it.each(METHODS)("%s denies with the boundary response", async (method) => {
    const handler = (route as Record<string, unknown>)[method] as Handler;
    for (const path of ["/", "/anything/nested/deep", "/api/admin", "/robots.txt"]) {
      const response = handler(new Request(new URL(path, "http://localhost"), { method }));
      expect(response.status, `${method} ${path}`).toBe(403);
      expectDenialHeaders(response.headers);
      if (method === "HEAD") {
        expect(response.body).toBeNull();
      } else {
        expectDenialPage(await response.text());
      }
    }
  });

  it("uses one shared handler so no method can drift from the others", () => {
    const handlers = METHODS.map((method) => (route as Record<string, unknown>)[method]);
    expect(new Set(handlers).size).toBe(1);
  });
});
