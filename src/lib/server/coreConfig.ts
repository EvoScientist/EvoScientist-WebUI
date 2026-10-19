// The two values the WebUI's server reads from EvoScientist's config.yaml: the
// backend's port and the origins its browser boundary trusts. SECURITY: API
// keys and every other field in config.yaml are never read or returned; the
// settings page gets them from the backend's own GET /api/settings.

import { readFileSync } from "fs";
import { join } from "path";
import { CORE_SCHEMA, load as loadYaml } from "js-yaml";
import { pyStrip } from "@/lib/pythonWhitespace";
import { configDir } from "@/lib/server/paths";

/** The backend's default port (`langgraph_dev_port` in settings.py). */
export const DEFAULT_PORT = 6174;

// Long enough to spare a file read per request in a burst of route calls,
// short enough that a port saved in config.yaml shows up without a restart.
const CACHE_MS = 1000;

export interface CoreConfig {
  /** `EVOSCIENTIST_LANGGRAPH_DEV_PORT`, else `langgraph_dev_port`, else 6174. */
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
    port: envPort() ?? filePort(file.langgraph_dev_port) ?? DEFAULT_PORT,
    allowedOrigins: parseAllowedOrigins(file.backend_allowed_origins),
  };
  cached = { at: now, value };
  return value;
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
