import type { NextRequest } from "next/server";
import { relayWrite } from "@/lib/server/settingsRelay";

export async function POST(request: NextRequest) {
  return relayWrite(request, "POST", "/api/settings/test-key");
}
