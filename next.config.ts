import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the npm package (the bin launcher runs
  // dist/server.js). Needed because /api/skills is a server route.
  output: "standalone",
  // The only next/image is the 24px header logo, so serve images as they are
  // and ship no `sharp`: its native binary only loads on the platform that
  // published the package (#62). With this, /_next/image answers 404.
  images: { unoptimized: true },
  // The server keeps the pages it rendered in memory and writes none of them
  // to `.next/server/route-cache`. Its own folder is not a place to write
  // to: in the desktop app it is inside the signed app bundle, and on macOS
  // one file added there breaks the signature's seal, so the system reports
  // an app that was used once as modified. In the npm package it is the
  // install folder. The cache is small (the page shells) and is rebuilt on
  // the first request after a start.
  experimental: { isrFlushToDisk: false },
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
