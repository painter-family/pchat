import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Staged Cache Components renders currently reuse request-bound timers in
  // workerd. Use ordinary dynamic rendering for the production Worker.
  cacheComponents: process.env.PCHAT_BUILD_TARGET !== "worker",
  partialPrefetching: process.env.PCHAT_BUILD_TARGET !== "worker",
  serverExternalPackages: ["wrangler"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
