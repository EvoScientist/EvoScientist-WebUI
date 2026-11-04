import type { RelayRefusal } from "@/lib/settings";

// The WebUI's own relay to the core's AutoSkills write routes.

export type RelayReply =
  | { status: number; ok: boolean; data: Record<string, unknown> }
  | "network";

const RELAY_REFUSALS: Record<RelayRefusal, true> = {
  not_loopback: true,
  host_not_loopback: true,
  cross_origin: true,
  json_required: true,
  secret_missing: true,
  secret_rejected: true,
  backend_unreachable: true,
  backend_timeout: true,
  unsupported: true,
};

/** Whether the code is one the relay itself answers with. */
export function isRelayRefusal(code: string): code is RelayRefusal {
  return Object.hasOwn(RELAY_REFUSALS, code);
}

/** POST to the relay. A rejected fetch is "network"; a body that is not a
 *  JSON object reads as `{}`. */
export async function postRelay(
  body: Record<string, unknown>
): Promise<RelayReply> {
  let res: Response;
  try {
    res = await fetch("/api/autoskills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return "network";
  }
  const parsed: unknown = await res.json().catch(() => null);
  const data: Record<string, unknown> =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { status: res.status, ok: res.ok, data };
}
