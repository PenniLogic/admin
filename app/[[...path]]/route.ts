import { authorize } from "@/src/boundary/authorize";
import { denialResponse } from "@/src/boundary/denial";

/** Never prerendered: the denial is evaluated on every request. */
export const dynamic = "force-dynamic";

/**
 * Second layer behind proxy.ts: this optional catch-all owns every path, so a request that reaches
 * routing at all is still denied instead of finding a page, an API handler or a 404 document.
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
