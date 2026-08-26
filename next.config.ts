import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Don't advertise the framework and version to anyone scanning the site.
  poweredByHeader: false,

  // Security headers. A strict Content-Security-Policy is added at Stage 16
  // once we know every asset source; adding it now would mean loosening it
  // repeatedly as features land, which tends to end with it permanently loose.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // The app needs none of these.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
