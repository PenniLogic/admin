import type { NextConfig } from "next";

// The scaffold has no pages, images, fonts, client bundles or remote resources.
// Every request is decided in proxy.ts and the catch-all route; nothing here relaxes that.
// URL normalization redirects are disabled so no response leaves the server before the boundary runs.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
  skipMiddlewareUrlNormalize: true,
};

export default nextConfig;
