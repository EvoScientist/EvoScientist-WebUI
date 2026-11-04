import { NextResponse, type NextRequest } from "next/server";
import {
  forwardToBackend,
  localBackend,
  passThrough,
  readLocalSecret,
  refusal,
  relayGate,
} from "@/lib/server/settingsRelay";
import { isValidSkillName } from "@/lib/server/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The longest folder path taken. */
const MAX_PATH = 4096;

type Plan = { path: string; body: Record<string, unknown> };

const invalidRequest = () =>
  NextResponse.json(
    { error: "invalid_request" },
    { status: 400, headers: { "Cache-Control": "no-store" } }
  );

/** The core path and body a request stands for, or null when it is not one
 *  of the four actions with valid fields. */
function planOf(raw: unknown): Plan | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const body = raw as Record<string, unknown>;
  if (body.action === "run") {
    const folder = body.workspace_dir;
    if (typeof folder !== "string") return null;
    // eslint-disable-next-line no-control-regex
    const control = /[\u0000-\u001f]/.test(folder);
    if (!folder.trim() || folder.length > MAX_PATH || control) return null;
    return { path: "/api/autoskills/run", body: { workspace_dir: folder } };
  }
  const action = body.action;
  if (action !== "approve" && action !== "reject" && action !== "revert") {
    return null;
  }
  const id = body.proposal_id;
  if (typeof id !== "string" || !isValidSkillName(id)) return null;
  const path = `/api/autoskills/proposals/${encodeURIComponent(id)}/${action}`;
  if (action !== "approve") return { path, body: {} };
  const scope = body.scope ?? null;
  if (scope !== null && scope !== "workspace" && scope !== "global") {
    return null;
  }
  return { path, body: { scope } };
}

/**
 * Approve, reject or revert an AutoSkills draft, or start a run, on this
 * machine's backend. These need the local secret, which the browser never
 * holds: the same gate as the settings relay, then the request is checked,
 * the core path and body are built here, and the secret goes only to the
 * local backend. The backend's answer comes back unchanged.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const refused = relayGate(request, { requireJson: true });
  if (refused) return refusal(refused);
  const plan = planOf(await request.json().catch(() => null));
  if (plan === null) return invalidRequest();
  const backend = localBackend();
  const secret = readLocalSecret(backend);
  if (secret === null) return refusal("secret_missing");
  const result = await forwardToBackend(backend, "POST", plan.path, {
    secret,
    body: JSON.stringify(plan.body),
  });
  return result.ok ? passThrough(result.response) : refusal(result.refusal);
}
