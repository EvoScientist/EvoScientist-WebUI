// The JSON lines of `EvoSci --version --json` (C08), `deploy --json` (C13),
// `setup --json` (C04) and `update --json` (C11). Each command prints one
// JSON object per line on stdout; later core versions may add fields and
// events, never rename or remove them, so unknown fields are kept and unknown
// events are passed through rather than refused.
import { StringDecoder } from "node:string_decoder";

/** Splits a byte stream into lines, across chunk and UTF-8 boundaries. */
export class LineSplitter {
  private decoder = new StringDecoder("utf8");
  private rest = "";

  /** The complete lines in this chunk; a trailing partial line is kept. */
  push(chunk: Buffer | string): string[] {
    this.rest += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const parts = this.rest.split(/\r?\n/);
    this.rest = parts.pop() ?? "";
    return parts;
  }

  /** The last line when the stream ended without a newline. */
  end(): string[] {
    this.rest += this.decoder.end();
    const last = this.rest.replace(/\r$/, "");
    this.rest = "";
    return last ? [last] : [];
  }
}

type Json = Record<string, unknown>;

/** The object on a line, or null for text, blank lines and non-objects. */
export function parseJsonLine(line: string): Json | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Json)
      : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};

// --- EvoSci --version --json -------------------------------------------------

export interface VersionInfo {
  version: string;
  protocol: number;
  webuiCompat: string;
}

/** The single line of `EvoSci --version --json`, or null when it is not one. */
export function parseVersionInfo(stdout: string): VersionInfo | null {
  for (const line of stdout.split(/\r?\n/)) {
    const v = parseJsonLine(line);
    if (!v) continue;
    const version = str(v.version);
    const compat = str(v.webui_compat);
    if (version && typeof v.protocol === "number" && compat) {
      return { version, protocol: v.protocol, webuiCompat: compat };
    }
  }
  return null;
}

// --- EvoSci deploy --json ----------------------------------------------------

export interface DeployReady {
  event: "ready";
  url: string;
  owned: boolean;
  workspace: string;
  dataDir: string;
  configDir: string;
  logFile: string;
  warnings: string[];
}

export interface DeployError {
  event: "error";
  code: string;
  message: string;
  detail: Json;
}

export type DeployEvent =
  | { event: "starting"; workspace?: string; port?: number }
  | DeployReady
  | DeployError
  | { event: "stopped" }
  | { event: "other"; raw: Json };

export function parseDeployEvent(line: string): DeployEvent | null {
  const v = parseJsonLine(line);
  if (!v || typeof v.event !== "string") return null;
  switch (v.event) {
    case "starting":
      return {
        event: "starting",
        workspace: str(v.workspace),
        port: typeof v.port === "number" ? v.port : undefined,
      };
    case "ready": {
      const url = str(v.url);
      if (!url || typeof v.owned !== "boolean")
        return { event: "other", raw: v };
      return {
        event: "ready",
        url,
        owned: v.owned,
        workspace: str(v.workspace) ?? "",
        dataDir: str(v.data_dir) ?? "",
        configDir: str(v.config_dir) ?? "",
        logFile: str(v.log_file) ?? "",
        warnings: Array.isArray(v.warnings)
          ? v.warnings.filter((w): w is string => typeof w === "string")
          : [],
      };
    }
    case "error":
      return {
        event: "error",
        code: str(v.code) ?? "internal_error",
        message: str(v.message) ?? "",
        detail: obj(v.detail),
      };
    case "stopped":
      return { event: "stopped" };
    default:
      return { event: "other", raw: v };
  }
}

// --- EvoSci setup --json / update --json ---------------------------------------

export type StageStatus = "running" | "done" | "skipped" | "error";

export interface StageEvent {
  stage: string;
  status: StageStatus;
  progress?: number;
  message?: string;
  detail: Json;
  code?: string;
}

const STATUSES: readonly string[] = ["running", "done", "skipped", "error"];

export function parseStageEvent(line: string): StageEvent | null {
  const v = parseJsonLine(line);
  if (!v) return null;
  const stage = str(v.stage);
  const status = str(v.status);
  if (!stage || !status || !STATUSES.includes(status)) return null;
  return {
    stage,
    status: status as StageStatus,
    progress: typeof v.progress === "number" ? v.progress : undefined,
    message: str(v.message),
    detail: obj(v.detail),
    code: str(v.code),
  };
}

/** A stage's terminal line: `done`, `skipped` or `error`. */
export function isTerminal(e: StageEvent): boolean {
  return e.status !== "running";
}
