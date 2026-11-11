import { NextResponse, type NextRequest } from "next/server";
import {
  forwardToBackend,
  localBackend,
  passThrough,
  readLocalSecret,
  refusal,
  relayGate,
} from "@/lib/server/settingsRelay";
import { requestFolder } from "@/lib/server/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Registration answers once the backend has restored the folder's
 *  conversations and imported its scheduled tasks; its own client waits up
 *  to 120 s for that, so this waits longer. */
const REGISTER_TIMEOUT_MS = 150_000;

/** The `{workspace_dir}` of a JSON body, or null for a body without one. */
async function folderOf(request: NextRequest): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as {
    workspace_dir?: unknown;
  } | null;
  return requestFolder(body?.workspace_dir);
}

const invalidPath = () =>
  NextResponse.json(
    { error: "invalid_path" },
    { status: 400, headers: { "Cache-Control": "no-store" } }
  );

/**
 * Add (`POST`) or remove (`DELETE`) a project on this machine's backend:
 * `{"workspace_dir": <path>}`. The same gate as the settings relay (this
 * server on loopback, a loopback Host, the WebUI's own origin, a JSON body),
 * then the local secret, sent only to the local backend. The backend checks
 * the folder (it must exist; it is never created) and answers; its answer
 * comes back unchanged.
 */
async function relay(
  request: NextRequest,
  method: "POST" | "DELETE"
): Promise<NextResponse> {
  const refused = relayGate(request, { requireJson: true });
  if (refused) return refusal(refused);
  const folder = await folderOf(request);
  if (folder === null) return invalidPath();
  const backend = localBackend();
  const secret = readLocalSecret(backend);
  if (secret === null) return refusal("secret_missing");
  const result =
    method === "POST"
      ? await forwardToBackend(backend, "POST", "/api/workspaces", {
          secret,
          body: JSON.stringify({ workspace_dir: folder }),
          timeoutMs: REGISTER_TIMEOUT_MS,
        })
      : await forwardToBackend(
          backend,
          "DELETE",
          `/api/workspaces?${new URLSearchParams({ workspace_dir: folder })}`,
          { secret, timeoutMs: REGISTER_TIMEOUT_MS }
        );
  return result.ok ? passThrough(result.response) : refusal(result.refusal);
}

export function POST(request: NextRequest) {
  return relay(request, "POST");
}

export function DELETE(request: NextRequest) {
  return relay(request, "DELETE");
}
