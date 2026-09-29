import { authorize } from "@/src/boundary/authorize";
import { denialResponse } from "@/src/boundary/denial";

/** Never prerendered: the denial is evaluated on every request. */
export const dynamic = "force-dynamic";

/**
 * Backstop behind proxy.ts: this optional catch-all owns every path that reaches routing, so no
 * page or API handler can be found. It is not the boundary. Without proxy.ts the framework would
 * still serve built static assets and its own 404 document before routing; proxy.ts is what denies
 * every forwarded request.
 */
function deny(request: Request): Response {
  return denialResponse(authorize(), request.method);
}

export {
  deny as GET,
  deny as HEAD,
  deny as POST,
  deny as PUT,
  deny as PATCH,
  deny as DELETE,
  deny as OPTIONS,
};
