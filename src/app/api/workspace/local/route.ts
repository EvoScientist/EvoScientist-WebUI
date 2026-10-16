import { promises as fs } from "fs";
import { type NextRequest, NextResponse } from "next/server";

import { getWorkspaceDir, isCrossOrigin } from "@/lib/server/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

/**
 * Whether this machine's workspace is the backend's folder.
 *
 * The file routes read and write the folder the sidecar names on this
 * machine; the backend runs in the folder it reports itself (`key`, from its
 * `GET /api/workspace`). They are the same folder only when both resolve to
 * the same path here — a remote backend's folder usually doesn't exist on
 * this machine at all. `404` when this machine has no active workspace.
 */
export async function GET(request: NextRequest) {
  if (isCrossOrigin(request)) {
    return NextResponse.json(
      { error: "Cross-origin workspace access is not allowed." },
      { status: 403, headers: NO_STORE_HEADERS }
    );
  }
  const key = request.nextUrl.searchParams.get("key");
  if (!key) {
    return NextResponse.json(
      { error: "The backend's folder is required (key)." },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }
  let dir: string;
  try {
    dir = await getWorkspaceDir();
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "No local workspace found.",
      },
      { status: 404, headers: NO_STORE_HEADERS }
    );
  }
  const sameFolder = await fs.realpath(key).then(
    (resolved) => resolved === dir,
    () => false
  );
  return NextResponse.json({ dir, sameFolder }, { headers: NO_STORE_HEADERS });
}
