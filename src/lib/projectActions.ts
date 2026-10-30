// Adding and removing projects, through the WebUI's /api/projects relay
// (which adds the local secret): the requests and the words for their
// answers.

import { isLoopbackHost } from "@/lib/backendBoundary";
import type { RelayRefusal, SettingsWriteAccess } from "@/lib/settings";

/** The backend has no auth: what anyone who reaches it can do. */
const EXPOSED =
  "has no auth: anyone who reaches it can read every project it serves and run the agent, with shell access, in any of them.";

/** The warnings for a backend that can be reached from other machines, in
 *  the core's words (`exposure_warnings` in langgraph_dev/registration.py). */
export function exposureWarnings(host: unknown, tunnel: unknown): string[] {
  const warnings: string[] = [];
  if (typeof host === "string" && !isLoopbackHost(host.trim())) {
    warnings.push(
      `The agent server listens on ${
        host.trim() || "every interface"
      } and ${EXPOSED} Trusted networks only.`
    );
  }
  if (tunnel === true) {
    warnings.push(
      `The agent server is reachable through a public tunnel and ${EXPOSED} Share its URL only with people you trust.`
    );
  }
  return warnings;
}

const REFUSAL_TEXT: Record<RelayRefusal | "other_backend", string> = {
  not_loopback:
    "This WebUI server listens on the network, not on this machine only, so it doesn't change projects. Start it with EvoSci --ui webui, or with npm run dev:local.",
  host_not_loopback:
    "This page is open by a network address. Projects are added and removed from a page open at 127.0.0.1 or localhost on the machine that runs EvoScientist.",
  cross_origin: "This page is not on the WebUI's own address.",
  json_required: "The WebUI sent a request the backend does not take.",
  secret_missing:
    "The WebUI cannot read EvoScientist's local secret. Start EvoSci once so it creates it, and check that the WebUI and EvoScientist use the same data folder.",
  secret_rejected:
    "EvoScientist refused this machine's local secret: the WebUI and EvoScientist use different data folders.",
  backend_unreachable:
    "The WebUI server cannot reach EvoScientist on this machine.",
  backend_timeout: "EvoScientist did not answer in time.",
  unsupported:
    "This EvoScientist version cannot change projects from the WebUI.",
  other_backend:
    "The deployment URL is not the EvoScientist that runs next to this WebUI server, so projects are added and removed on the machine that runs it.",
};

/** Why this page can't add or remove projects, or null when it can. */
export function projectsReadOnlyReason(
  access: SettingsWriteAccess | undefined
): string | null {
  if (!access) return "Checking whether this page can change projects…";
  return access.writable ? null : REFUSAL_TEXT[access.reason];
}

interface ErrorBody {
  error?: unknown;
  detail?: unknown;
  cron_ids?: unknown;
}

function errorText(body: ErrorBody, status: number): string {
  const code = typeof body.error === "string" ? body.error : "";
  switch (code) {
    case "invalid_path":
      return "Give the folder's full path, for example /home/you/my-project.";
    case "folder_missing":
      return "There is no folder at that path. EvoScientist adds only folders that exist; it never creates one.";
    case "setup_failed":
      return `Setting the project up failed${
        typeof body.detail === "string" && body.detail
          ? `: ${body.detail}`
          : "."
      }`;
    case "not_registered":
      return "That folder isn't a project on this backend.";
    case "enabled_user_crons":
      return "The project has scheduled tasks that are on. Pause them first.";
    case "unregister_failed":
      return "Removing the project failed. Try again.";
    case "local_secret_required":
      return REFUSAL_TEXT.secret_rejected;
    default:
      if (code in REFUSAL_TEXT) {
        return REFUSAL_TEXT[code as RelayRefusal];
      }
      return `EvoScientist answered ${status}.`;
  }
}

async function send(
  method: "POST" | "DELETE",
  folder: string
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch("/api/projects", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_dir: folder }),
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      status: 0,
      body: { error: "backend_unreachable" },
    };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
}

export type AddProjectResult =
  | {
      ok: true;
      /** The project's key, as the backend stores it. */
      key: string;
      /** How the backend can be reached from other machines, if it can. */
      warnings: string[];
    }
  | { ok: false; message: string };

/** Register `folder` (an absolute path; `~` is expanded by the backend). */
export async function addProject(folder: string): Promise<AddProjectResult> {
  const { ok, status, body } = await send("POST", folder);
  if (!ok || typeof body.workspace_dir !== "string") {
    return { ok: false, message: errorText(body, status) };
  }
  return {
    ok: true,
    key: body.workspace_dir,
    warnings: exposureWarnings(body.host, body.tunnel),
  };
}

export type RemoveProjectResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      /** Scheduled tasks that are on, when that is why it refused. */
      cronIds: string[];
      /** The backend has no such project (removed already). */
      gone?: boolean;
    };

/** Remove the project at `key` from the backend. Its folder, files and
 *  conversations stay. */
export async function removeProject(key: string): Promise<RemoveProjectResult> {
  const { ok, status, body } = await send("DELETE", key);
  if (ok) return { ok: true };
  return {
    ok: false,
    gone: status === 404 && body.error === "not_registered",
    message: errorText(body, status),
    cronIds: Array.isArray(body.cron_ids)
      ? body.cron_ids.filter((id): id is string => typeof id === "string")
      : [],
  };
}
