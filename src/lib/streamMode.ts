// Filter unsupported `stream_mode` values before they hit the LangGraph API.
//
// Starting with `@langchain/langgraph-sdk` 1.6.5 the client auto-tracks a
// `"tools"` stream mode (populates `stream.toolProgress`). The wire-level
// `stream_mode` array we send therefore includes `"tools"` any time subagent
// or tool-related state has been observed. The backend `langgraph-api` schema
// (checked live against `/openapi.json` on our current 0.10.0 deployment) does
// not accept `"tools"` yet — the `RunCreateStateful.stream_mode.anyOf` enum
// tops out at `custom`. Sending `"tools"` produces `HTTP 422` on every submit.
//
// Approach cribbed from `bytedance/deer-flow#1050`: wrap `client.runs.stream`
// and `client.runs.joinStream` at construction time to drop unsupported modes
// from the payload. Warn once per unrecognized mode so a future backend upgrade
// that adds a new mode surfaces itself in the dev log.

import { Client } from "@langchain/langgraph-sdk";

const SUPPORTED_STREAM_MODES = new Set([
  "values",
  "messages",
  "messages-tuple",
  "updates",
  "events",
  "debug",
  "tasks",
  "checkpoints",
  "custom",
]);

const warnedModes = new Set<string>();
function warnUnsupportedStreamModes(dropped: string[]): void {
  for (const mode of dropped) {
    if (warnedModes.has(mode)) continue;
    warnedModes.add(mode);
    console.warn(
      `[stream-mode] dropped unsupported mode "${mode}" — backend does not accept it. ` +
        `See src/lib/streamMode.ts for the current allowlist.`
    );
  }
}

function sanitizeStreamMode<T>(streamMode: T): T {
  if (Array.isArray(streamMode)) {
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const mode of streamMode) {
      if (typeof mode === "string" && SUPPORTED_STREAM_MODES.has(mode)) {
        kept.push(mode);
      } else if (typeof mode === "string") {
        dropped.push(mode);
      }
    }
    if (dropped.length > 0) warnUnsupportedStreamModes(dropped);
    return kept as unknown as T;
  }
  if (
    typeof streamMode === "string" &&
    !SUPPORTED_STREAM_MODES.has(streamMode)
  ) {
    warnUnsupportedStreamModes([streamMode]);
    return undefined as unknown as T;
  }
  return streamMode;
}

// Payload for `runs.joinStream` can be either a plain `AbortSignal` or an
// options object — the SDK type is a union. Anything that isn't an object with
// a `streamMode` property gets returned untouched.
function sanitizePayload<T>(payload: T): T {
  if (!payload || typeof payload !== "object") return payload;
  if (payload instanceof AbortSignal) return payload;
  if (!("streamMode" in payload)) return payload;
  const withMode = payload as { streamMode?: unknown };
  return {
    ...payload,
    streamMode: sanitizeStreamMode(withMode.streamMode),
  } as T;
}

// Patch a Client instance in place. Idempotent: subsequent calls no-op via a
// sentinel property so accidental double-wrapping doesn't stack interceptors.
const PATCHED = Symbol.for("evoscientist.streamModePatched");
type Patched = { [PATCHED]?: boolean };

export function patchClientStreamModes(client: Client): Client {
  const marker = client.runs as unknown as Patched;
  if (marker[PATCHED]) return client;
  marker[PATCHED] = true;

  const originalStream = client.runs.stream.bind(client.runs);
  const originalJoinStream = client.runs.joinStream.bind(client.runs);

  (client.runs as any).stream = (
    threadId: string,
    assistantId: string,
    payload?: Parameters<typeof client.runs.stream>[2]
  ) => originalStream(threadId, assistantId, sanitizePayload(payload));

  (client.runs as any).joinStream = (
    threadId: string,
    runId: string,
    options?: Parameters<typeof client.runs.joinStream>[2]
  ) => originalJoinStream(threadId, runId, sanitizePayload(options));

  return client;
}

// Convenience: construct a Client and immediately patch it. Preferred entry
// point for `new Client({...})` callsites so the sanitizer can't be forgotten.
export function makeClient(
  options: ConstructorParameters<typeof Client>[0]
): Client {
  return patchClientStreamModes(new Client(options));
}
