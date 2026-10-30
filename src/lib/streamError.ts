import type { Client } from "@langchain/langgraph-sdk";

export function formatStreamError(error: unknown): string {
  const cap = (s: string) => (s.length > 300 ? s.slice(0, 297) + "..." : s);
  if (typeof error === "string" && error.trim()) return cap(error.trim());
  if (error && typeof error === "object") {
    const e = error as {
      name?: unknown;
      message?: unknown;
      error?: unknown;
      provider?: unknown;
      status_code?: unknown;
      code?: unknown;
      request_id?: unknown;
    };
    const msg = typeof e.message === "string" ? e.message.trim() : null;
    if (typeof e.provider === "string" && e.provider && msg) {
      const label =
        typeof e.error === "string" && e.error.trim() ? e.error.trim() : null;
      const details = [
        e.provider,
        typeof e.status_code === "number" ? String(e.status_code) : null,
        typeof e.code === "string" && e.code ? e.code : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const requestId =
        typeof e.request_id === "string" && e.request_id
          ? ` [${e.request_id}]`
          : "";
      const head = label ? `${label}: ${msg}` : msg;
      return cap(`${head} (${details})${requestId}`);
    }
    const name = typeof e.name === "string" ? e.name.trim() : null;
    let inner: string | null = null;
    if (typeof e.error === "string" && e.error.trim()) {
      inner = e.error.trim();
    } else if (e.error && typeof e.error === "object") {
      try {
        inner = JSON.stringify(e.error);
      } catch {
        inner = null;
      }
    }
    const body = msg ?? inner;
    const combined = name && body ? `${name}: ${body}` : name ?? body ?? "";
    if (combined) return cap(combined);
  }
  return "Run failed.";
}

export function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    status_code?: unknown;
    response?: { status?: unknown };
  };
  const candidates = [
    value.status,
    value.statusCode,
    value.status_code,
    value.response?.status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number") return candidate;
    if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) {
      return Number(candidate);
    }
  }
  return undefined;
}

/**
 * The thread id named by a history-style 404 (`Thread with ID <id> not
 * found`), or null when the error doesn't name one (run-path
 * `Thread or assistant not found.`). Lets the recovery path check the report
 * is about the thread that is still open — the SDK invokes the newest
 * `onError` for a history fetch even when that fetch belonged to a thread the
 * URL has since left (browser back/forward switches threads in place).
 */
export function missingThreadIdFromError(error: unknown): string | null {
  const match = /thread with id '?([0-9a-f-]{8,})'?/i.exec(
    formatStreamError(error)
  );
  return match ? match[1] : null;
}

export function isMissingThreadOrAssistantError(error: unknown): boolean {
  const message = formatStreamError(error).toLowerCase();
  const is404 = getHttpStatus(error) === 404 || /\bhttp\s*404\b/.test(message);
  if (!is404) return false;

  return (
    message.includes("thread or assistant not found") ||
    (message.includes("thread with id") && message.includes("not found")) ||
    (message.includes("assistant with id") && message.includes("not found"))
  );
}

/** The core's `RunFolderMismatchError` and its subclasses: a run for a
 *  project the backend doesn't serve (`ProjectNotServedError`), and a new
 *  conversation on no known project's assistant (`NoProjectError`). */
const FOLDER_REFUSALS = [
  "RunFolderMismatchError",
  "ProjectNotServedError",
  "NoProjectError",
];

/**
 * The run was refused for its folder: the backend doesn't serve the folder
 * the run is for. A run error carries its exact class name, so each of the
 * core's refusals is matched. It reaches `useStream` as an error with that
 * name, and `runs.wait` as a message starting with it.
 */
export function isRunFolderMismatchError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof name === "string" && FOLDER_REFUSALS.includes(name)) return true;
  const message = formatStreamError(error);
  return FOLDER_REFUSALS.some((refusal) => message.includes(refusal));
}

/**
 * After a run 404 ("Thread or assistant not found."): whether the assistant,
 * not the thread, is what's missing. Only a 404 for the thread means it is
 * gone; any other failure to check keeps it.
 */
export async function assistantIsMissing(
  client: Client,
  threadId: string | null
): Promise<boolean> {
  if (!threadId) return true;
  try {
    await client.threads.get(threadId);
    return true;
  } catch (error) {
    return getHttpStatus(error) !== 404;
  }
}
