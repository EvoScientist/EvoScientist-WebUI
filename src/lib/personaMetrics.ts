// Metrics derived from a sub-thread's persisted messages, used by
// PersonaFocusView's header strip ("Tools: N · in Xk · out Yk · Updated: HH:MM").
//
// Kept as pure functions so PersonaFocusView can memoize on the messages array
// without extra state, and so unit tests stay cheap.

/** Count tool_calls entries across all AI messages. Mirrors the shape
 *  `normalizeToolCalls` in subAgentActivity.ts recognizes: prefer top-level
 *  `tool_calls` (LangChain shape), fall back to
 *  `additional_kwargs.tool_calls` (OpenAI shape). Non-AI messages contribute 0. */
export function computeToolCount(messages: unknown[]): number {
  let count = 0;
  for (const raw of messages) {
    const m = raw as {
      type?: string;
      tool_calls?: unknown[];
      additional_kwargs?: { tool_calls?: unknown[] };
    };
    if (m.type !== "ai") continue;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      count += m.tool_calls.length;
      continue;
    }
    const ak = m.additional_kwargs?.tool_calls;
    if (Array.isArray(ak)) count += ak.length;
  }
  return count;
}

/** Sum LangChain `usage_metadata.input_tokens` / `output_tokens` across AI
 *  messages. Both are integers as emitted; sub-agent turns without usage
 *  contribute 0. Non-AI messages are ignored. */
export function computeTokenTotals(messages: unknown[]): {
  input: number;
  output: number;
} {
  let input = 0;
  let output = 0;
  for (const raw of messages) {
    const m = raw as {
      type?: string;
      usage_metadata?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    if (m.type !== "ai") continue;
    const u = m.usage_metadata;
    if (!u) continue;
    if (typeof u.input_tokens === "number") input += u.input_tokens;
    if (typeof u.output_tokens === "number") output += u.output_tokens;
  }
  return { input, output };
}

/** Compact token-count formatter for the header strip: 394600 → "394.6k",
 *  7200 → "7.2k", 987 → "987", 0 → "0". One decimal for the "k" bucket so
 *  short and long counts have similar visual weight. */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  // Trim trailing ".0" so 5000 → "5k", not "5.0k".
  const s = k.toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}k`;
}

/** ISO timestamp of the most recently authored message on the thread, or
 *  null if none of the messages carry a resolvable timestamp. Priority per
 *  message: `updated_at`, then `created_at`, then
 *  `additional_kwargs.updated_at`. Chooses the maximum across the list so
 *  out-of-order messages still surface the newest write. */
export function lastUpdatedAt(messages: unknown[]): string | null {
  let bestMs = -Infinity;
  let bestIso: string | null = null;
  for (const raw of messages) {
    const m = raw as {
      updated_at?: unknown;
      created_at?: unknown;
      additional_kwargs?: { updated_at?: unknown };
    };
    const candidates = [
      m.updated_at,
      m.created_at,
      m.additional_kwargs?.updated_at,
    ];
    for (const c of candidates) {
      if (typeof c !== "string") continue;
      const ms = Date.parse(c);
      if (Number.isNaN(ms)) continue;
      if (ms > bestMs) {
        bestMs = ms;
        bestIso = c;
      }
    }
  }
  return bestIso;
}
