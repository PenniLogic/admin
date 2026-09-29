import type { NextRequest } from "next/server";

import { authorize } from "@/src/boundary/authorize";
import { denialResponse } from "@/src/boundary/denial";

/**
 * Request boundary of the administrative console.
 *
 * No matcher is configured, so this runs for every request path, including framework-internal
 * ones, before any route is considered. Nothing passes until an administrative identity provider
 * is configured and reviewed; until then the boundary answers every request with a denial.
 */
export function proxy(request: NextRequest): Response {
  return denialResponse(authorize(), request.method);
}
