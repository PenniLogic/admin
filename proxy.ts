import type { NextRequest } from "next/server";

import { authorize } from "@/src/boundary/authorize";
import { denialResponse } from "@/src/boundary/denial";

/**
 * Request boundary of the administrative console.
 *
 * No matcher is configured, so this runs for every request the framework forwards, including
 * framework-internal paths, before any route is considered. Nothing passes until an administrative
 * identity provider is configured and reviewed; until then every forwarded request is denied.
 * Requests the framework answers on its own (documented in docs/scaffold.md) must be rejected by
 * the deployment edge.
 */
export function proxy(request: NextRequest): Response {
  return denialResponse(authorize(), request.method);
}
