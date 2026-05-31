import type { NextConfig } from "next";

// EvoScientist `EvoSci deploy` backend (langgraph dev), default 127.0.0.1:6174.
// Override with LANGGRAPH_API_URL if you used `EvoSci deploy --port <other>`.
const LANGGRAPH_TARGET =
  process.env.LANGGRAPH_API_URL || "http://127.0.0.1:6174";

const nextConfig: NextConfig = {
  // Allow loading the dev UI (and its HMR resources) from these LAN hosts,
  // e.g. opening http://192.168.0.59:3000 from a phone on the same Wi-Fi.
  // Add/replace with your Mac's LAN IP (see `ipconfig getifaddr en0`).
  allowedDevOrigins: ["192.168.0.59"],

  // Same-origin reverse proxy to the EvoScientist backend. The browser talks
  // only to this Next server; Next (running on the Mac) forwards to the
  // backend on 127.0.0.1. This lets a phone reach the backend WITHOUT the
  // EvoScientist repo binding to 0.0.0.0, and avoids cross-origin/CORS issues.
  // In the UI's config dialog, set Deployment URL to:  <this-origin>/lg
  // Dev-only: rewrites don't apply to a future static export build.
  async rewrites() {
    return [
      {
        source: "/lg/:path*",
        destination: `${LANGGRAPH_TARGET}/:path*`,
      },
    ];
  },
};

export default nextConfig;
