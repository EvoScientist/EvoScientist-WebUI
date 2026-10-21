import type { NextRequest } from "next/server";
import { relayWrite } from "@/lib/server/settingsRelay";

// Writes go through this route so the browser never holds the local secret;
// reads go from the browser to the backend's GET /api/settings directly.
export async function PATCH(request: NextRequest) {
  return relayWrite(request, "PATCH", "/api/settings");
}
