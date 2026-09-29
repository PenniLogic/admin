import { describe, expect, expectTypeOf, it } from "vitest";

import {
  authorize,
  type Decision,
  type Denied,
  NO_ADMINISTRATIVE_IDENTITY_PROVIDER,
} from "@/src/boundary/authorize";

describe("authorize", () => {
  it("denies because no administrative identity provider is configured", () => {
    const decision = authorize();
    expect(decision.outcome).toBe("denied");
    expect(decision.reason).toBe(NO_ADMINISTRATIVE_IDENTITY_PROVIDER);
    expect(decision.reason).toBe("no-administrative-identity-provider");
  });

  it("is deterministic and takes no request input", () => {
    expect(authorize.length).toBe(0);
    expect(authorize()).toBe(authorize());
    expect(authorize()).toStrictEqual({
      outcome: "denied",
      reason: NO_ADMINISTRATIVE_IDENTITY_PROVIDER,
    });
  });

  it("returns a frozen decision that cannot be mutated into an allow", () => {
    const decision = authorize() as { outcome: string };
    expect(Object.isFrozen(decision)).toBe(true);
    expect(() => {
      decision.outcome = "allowed";
    }).toThrow(TypeError);
    expect(authorize().outcome).toBe("denied");
  });

  it("has no allowed member in the decision type", () => {
    expectTypeOf<Decision>().toEqualTypeOf<Denied>();
    expectTypeOf<Decision["outcome"]>().toEqualTypeOf<"denied">();
    expectTypeOf<Decision["reason"]>().toEqualTypeOf<"no-administrative-identity-provider">();
  });
});
