import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the npm package (the bin launcher runs
  // dist/server.js). Needed because /api/skills is a server route.
  output: "standalone",
  // The only next/image is the 24px header logo, so serve images as they are
  // and ship no `sharp`: its native binary only loads on the platform that
  // published the package (#62). With this, /_next/image answers 404.
  images: { unoptimized: true },
  // `unoptimized` alone still traces sharp into the standalone output.
  // Routes that resolve dynamic paths trace the whole project root, which
  // includes the desktop app (and its packed build after `npm run pack`).
  outputFileTracingExcludes: {
    "*": [
      "**/node_modules/sharp/**/*",
      "**/node_modules/@img/**/*",
      "desktop/**/*",
    ],
  },
};

export default nextConfig;
