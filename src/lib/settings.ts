// EvoScientist's settings as the WebUI sees them: the backend's
// `GET /api/settings` body, the answer of this WebUI's own
// `GET /api/settings/access`, and the rule that combines the two into "this
// page can save settings" (WebUI#55, point 4).

import { isLoopbackHost } from "@/lib/backendBoundary";

/** Why the WebUI's settings relay refuses a request; also the `reason` of
 *  GET /api/settings/access. */
export type RelayRefusal =
  | "not_loopback"
  | "host_not_loopback"
  | "cross_origin"
  | "json_required"
  | "secret_missing"
  | "secret_rejected"
  | "backend_unreachable"
  | "backend_timeout"
  | "unsupported";

/** The answer of the WebUI's GET /api/settings/access. */
export type SettingsAccess =
  | {
      writable: true;
      /** The port of the backend the relay writes to. */
      port: number;
      /** That backend's `instance` (WebUI#55, point 4). */
      instance: string;
      /** The `revision` that backend reports; compared with the page's own
       *  GET when the backend has no `instance` field. */
      revision: string | null;
    }
  | { writable: false; reason: RelayRefusal };

/** Where a setting's value comes from in the running backend. */
export interface SettingSource {
  source: string;
  path?: string;
  /** An override (environment, CLI, `.env`) hides the saved value. */
  shadowed: boolean;
}

/** What the backend needs for one provider. */
export interface ProviderInfo {
  label: string;
  key_field: string | null;
  base_url_field: string | null;
  needs_key: boolean;
  needs_base_url: boolean;
  has_check: boolean;
  lists_models: boolean;
}

/** The backend's GET /api/settings body. */
export interface SettingsPayload {
  settings: Record<string, unknown>;
  sources: Record<string, SettingSource>;
  read_only: string[];
  providers: Record<string, ProviderInfo>;
  setup_needed: boolean;
  restart_required: boolean;
  restart_fields: string[];
  /** sha256 of config.yaml, null without the file. */
  revision: string | null;
  config_error: { error: string; path: string; detail: string } | null;
  /** Names the backend's local secret; absent before the field existed. */
  instance?: string | null;
}

/** Whether the page can save settings to the backend it shows. */
export type SettingsWriteAccess =
  | { writable: true }
  | {
      writable: false;
      /** `other_backend`: the relay writes to a different backend than the
       *  one the page reads. */
      reason: RelayRefusal | "other_backend";
    };

/** The deployment URL names the backend on this machine at `port`. */
export function isLocalDeployment(
  deploymentUrl: string,
  port: number
): boolean {
  let url: URL;
  try {
    url = new URL(deploymentUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    isLoopbackHost(url.hostname) &&
    Number(url.port || "80") === port
  );
}

/**
 * The page can save when the relay can write (`access`), the deployment URL
 * is the local backend the relay writes to, and that backend is the one the
 * page read (`settings`): the same `instance` (`null` from a backend that
 * loaded no local secret, which matches none), or, from a backend without
 * the field, the same `revision`. Host and port alone can name another machine's
 * backend through a tunnel.
 */
export function settingsWriteAccess(
  deploymentUrl: string,
  access: SettingsAccess,
  settings: Pick<SettingsPayload, "instance" | "revision">
): SettingsWriteAccess {
  if (!access.writable) return access;
  if (!isLocalDeployment(deploymentUrl, access.port)) {
    return { writable: false, reason: "other_backend" };
  }
  const same =
    settings.instance === undefined
      ? settings.revision === access.revision
      : settings.instance === access.instance;
  return same
    ? { writable: true }
    : { writable: false, reason: "other_backend" };
}

/** A minimal shape check of a GET /api/settings body. */
export function isSettingsPayload(value: unknown): value is SettingsPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const isObject = (x: unknown) => typeof x === "object" && x !== null;
  return (
    isObject(v.settings) &&
    isObject(v.sources) &&
    isObject(v.providers) &&
    Array.isArray(v.read_only) &&
    typeof v.setup_needed === "boolean"
  );
}
