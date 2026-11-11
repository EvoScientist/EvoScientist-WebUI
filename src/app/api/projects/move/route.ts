import { NextResponse, type NextRequest } from "next/server";
import {
  forwardSlowToBackend,
  localBackend,
  passThrough,
  readLocalSecret,
  refusal,
  relayGate,
} from "@/lib/server/settingsRelay";
import { moveSupported, requestFolder } from "@/lib/server/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A move answers once the project's conversations, scheduled tasks and
 *  memory have followed it; its own client waits up to 30 min. */
const MOVE_TIMEOUT_MS = 30 * 60_000;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Whether this page can move projects on the local backend:
 * `{"supported": <bool>}`, false when the relay would refuse the page (as
 * for adding and removing) or the backend has no move. A backend that can't
 * be reached is a refusal: whether it can move isn't known yet.
 */
export async function GET(request: NextRequest) {
  if (relayGate(request, { requireJson: false }) !== null) {
    return NextResponse.json({ supported: false }, { headers: NO_STORE });
  }
  const supported = await moveSupported();
  if (typeof supported !== "boolean") return refusal(supported);
  return NextResponse.json({ supported }, { headers: NO_STORE });
}

/**
 * Move the registered project `old` to the folder `new` on this machine's
 * backend: `{"old": <path>, "new": <path>}`. The same gate and local secret
 * as adding and removing a project; the backend's answer comes back
 * unchanged.
 */
export async function POST(request: NextRequest) {
  const refused = relayGate(request, { requireJson: true });
  if (refused) return refusal(refused);
  const body = (await request.json().catch(() => null)) as {
    old?: unknown;
    new?: unknown;
  } | null;
  const old = requestFolder(body?.old);
  const folder = requestFolder(body?.new);
  if (old === null || folder === null) {
    return NextResponse.json(
      { error: "invalid_path" },
      { status: 400, headers: NO_STORE }
    );
  }
  const backend = localBackend();
  const secret = readLocalSecret(backend);
  if (secret === null) return refusal("secret_missing");
  const result = await forwardSlowToBackend(
    backend,
    "POST",
    "/api/workspaces/move",
    {
      secret,
      body: JSON.stringify({ old, new: folder }),
      timeoutMs: MOVE_TIMEOUT_MS,
    }
  );
  return result.ok ? passThrough(result.response) : refusal(result.refusal);
}
