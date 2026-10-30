// The two values the WebUI's server takes from EvoScientist's configuration:
// the backend's port (also from the running backend's own record) and the
// origins its browser boundary trusts (config.yaml). SECURITY: API keys and
// every other field in config.yaml are never read or returned; the settings
// page gets them from the backend's own GET /api/settings.

import { readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { CORE_SCHEMA, load as loadYaml } from "js-yaml";
import { pyStrip } from "@/lib/pythonWhitespace";
import { configDir } from "@/lib/server/paths";

/** The backend's default port (`langgraph_dev_port` in settings.py). */
export const DEFAULT_PORT = 6174;

// Long enough to spare file reads per request in a burst of route calls,
// short enough that a backend restarted on another port, or a port saved in
// config.yaml while none runs, shows up without restarting the WebUI.
const CACHE_MS = 1000;

export interface CoreConfig {
  /** `EVOSCIENTIST_LANGGRAPH_DEV_PORT`, else the port the running backend
   *  recorded, else `langgraph_dev_port`, else 6174. */
  port: number;
  /** The valid origins in `backend_allowed_origins`. */
  allowedOrigins: string[];
}

let cached: { at: number; value: CoreConfig } | null = null;

/** Test hook: forget the cached values. */
export function resetCoreConfigCache(): void {
  cached = null;
}

export function configPath(): string {
  return join(configDir(), "config.yaml");
}

/** The backend's port and trusted origins, read the way the backend reads
 *  them. A missing or unparseable file gives the defaults, as the backend
 *  itself then runs with them. */
export function readCoreConfig(now: number = Date.now()): CoreConfig {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const file = readConfigFile();
  const value: CoreConfig = {
    port:
      envPort() ??
      recordedPort() ??
      filePort(file.langgraph_dev_port) ??
      DEFAULT_PORT,
    allowedOrigins: parseAllowedOrigins(file.backend_allowed_origins),
  };
  cached = { at: now, value };
  return value;
}

/** The record the running backend keeps of itself (`DEFAULT_PID_DIR` in
 *  langgraph_dev/manager.py): always ~/.config/evoscientist, whatever
 *  XDG_CONFIG_HOME says. */
function serverRecordPath(): string {
  return join(
    homedir(),
    ".config",
    "evoscientist",
    "langgraph_dev.workspace.json"
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists, it just isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The port the running backend recorded, while that server runs and
 *  it reads this config folder; null otherwise (an older core,
 *  none running, or one of another configuration). A backend started with
 *  `EvoSci deploy --port X` and a WebUI started apart from it only agree
 *  through it. */
function recordedPort(): number | null {
  try {
    const record = JSON.parse(readFileSync(serverRecordPath(), "utf8")) as {
      pid?: unknown;
      port?: unknown;
      config_dir?: unknown;
    };
    const port =
      typeof record.port === "number" ? validPort(record.port) : null;
    if (port === null) return null;
    if (
      typeof record.config_dir !== "string" ||
      resolve(record.config_dir) !== resolve(configDir())
    ) {
      return null;
    }
    const pid = record.pid;
    // 0 and below name process groups, which always answer.
    if (!Number.isInteger(pid) || (pid as number) < 1) return null;
    if (!isAlive(pid as number)) return null;
    return port;
  } catch {
    return null;
  }
}

function readConfigFile(): Record<string, unknown> {
  try {
    const data = loadYaml(readFileSync(configPath(), "utf-8"), {
      schema: CORE_SCHEMA,
    });
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function envPort(): number | null {
  const raw = process.env.EVOSCIENTIST_LANGGRAPH_DEV_PORT;
  return raw && /^\d+$/.test(raw.trim()) ? validPort(Number(raw.trim())) : null;
}

function filePort(value: unknown): number | null {
  if (typeof value === "number") return validPort(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return validPort(Number(value.trim()));
  }
  return null;
}

function validPort(n: number): number | null {
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * The valid origins in `backend_allowed_origins`, as the backend's
 * `parse_allowed_origins()` (langgraph_dev/boundary.py) takes them: a
 * comma-separated string or a YAML list; each entry stripped, a trailing `/`
 * dropped; http or https, a host and an optional port, nothing else.
 */
export function parseAllowedOrigins(value: unknown): string[] {
  const text = Array.isArray(value)
    ? value.map(String).join(",")
    : typeof value === "string"
    ? value
    : "";
  const origins: string[] = [];
  for (const part of text.split(",")) {
    let item = pyStrip(part);
    if (item.endsWith("/")) item = item.slice(0, -1);
    if (item && isOrigin(item)) origins.push(item);
  }
  return origins;
}

function isOrigin(item: string): boolean {
  let url: URL;
  try {
    url = new URL(item);
  } catch {
    return false;
  }
  // URL normalises an empty path to "/", so compare against the input: the
  // entry must be exactly scheme://host[:port].
  const rest = item.slice(url.protocol.length + 2);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === "" &&
    !/[/?#@]/.test(rest)
  );
}
