import { NextResponse, type NextRequest } from "next/server";
import {
  forwardToBackend,
  instanceOf,
  readLocalSecret,
  relayGate,
  type RelayRefusal,
} from "@/lib/server/settingsRelay";

export type SettingsAccess =
  | {
      writable: true;
      /** The backend `instance` this relay writes to (WebUI#55, point 4). */
      instance: string;
      /** The `revision` that backend reports; the page compares it with its
       *  own GET when the backend has no `instance` field yet. */
      revision: string | null;
    }
  | { writable: false; reason: RelayRefusal };

function answer(access: SettingsAccess): NextResponse {
  return NextResponse.json(access, {
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Whether this page's settings writes would go through, and why not: the
 * same checks as PATCH /api/settings, then the backend's own check of the
 * secret (GET /api/local-secret/verify, 204 or 403). Always 200: the answer
 * is the body.
 */
export async function GET(request: NextRequest) {
  const refused = relayGate(request, { requireJson: false });
  if (refused) return answer({ writable: false, reason: refused });
  const secret = readLocalSecret();
  if (secret === null) {
    return answer({ writable: false, reason: "secret_missing" });
  }
  const verify = await forwardToBackend("GET", "/api/local-secret/verify", {
    secret,
  });
  if (!verify.ok) return answer({ writable: false, reason: verify.refusal });
  const status = verify.response.status;
  if (status === 403) {
    return answer({ writable: false, reason: "secret_rejected" });
  }
  if (status === 404) return answer({ writable: false, reason: "unsupported" });
  if (status !== 204) {
    return answer({ writable: false, reason: "backend_unreachable" });
  }
  return answer({
    writable: true,
    instance: instanceOf(secret),
    revision: await backendRevision(),
  });
}

async function backendRevision(): Promise<string | null> {
  const result = await forwardToBackend("GET", "/api/settings");
  if (!result.ok || !result.response.ok) return null;
  const body = (await result.response.json().catch(() => null)) as {
    revision?: unknown;
  } | null;
  return typeof body?.revision === "string" ? body.revision : null;
}
