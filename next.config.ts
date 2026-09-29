import type { NextConfig } from "next";

// The scaffold has no pages, images, fonts, client bundles or remote resources.
// Every request the framework forwards is decided in proxy.ts; the catch-all route is a backstop.
// URL-normalization redirects are disabled so no response leaves the server before the boundary runs.
// tools/import-boundary/policy.mjs pins the complete set of keys this file may contain.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
  skipProxyUrlNormalize: true,
};

export default nextConfig;
