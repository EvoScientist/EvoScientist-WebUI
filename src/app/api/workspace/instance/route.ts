import { NextResponse, type NextRequest } from "next/server";
import { instanceOf, readLocalSecret } from "@/lib/server/settingsRelay";
import { isCrossOrigin } from "@/lib/server/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

/**
 * The `instance` of the backend this machine runs, from its local secret
 * file (the value its `GET /api/instance` answers), or null when no backend
 * has made one here. The file routes read this machine's disk for the
 * projects that backend serves, so the page shows files only when the
 * backend it talks to reports the same instance: a backend on another
 * machine, even with a project at the same path, reports another one.
 */
export async function GET(request: NextRequest) {
  if (isCrossOrigin(request)) {
    return NextResponse.json(
      { error: "Cross-origin workspace access is not allowed." },
      { status: 403, headers: NO_STORE_HEADERS }
    );
  }
  const secret = readLocalSecret();
  return NextResponse.json(
    { instance: secret ? instanceOf(secret) : null },
    { headers: NO_STORE_HEADERS }
  );
}
