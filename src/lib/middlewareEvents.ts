// Backend middleware events mirrored onto the LangGraph `custom` stream channel
// (EvoScientist/middleware/events.py). Payloads are `{evoscientist: {kind, …}}`;
// the tag keeps them apart from the sub-agent workflow events that share the
// channel. Only kinds the UI renders are parsed — the rest stay ignored.

const MIDDLEWARE_EVENT_TAG = "evoscientist";
const MAX_NOTICE_LENGTH = 240;

export interface FallbackNotice {
  text: string;
  level: "warning" | "success" | "error";
}

// The backend styles notices for a terminal (rich color names).
const LEVEL_BY_STYLE: Record<string, FallbackNotice["level"]> = {
  yellow: "warning",
  green: "success",
  red: "error",
};

export function parseFallbackNotice(data: unknown): FallbackNotice | null {
  if (!data || typeof data !== "object") return null;
  const payload = (data as Record<string, unknown>)[MIDDLEWARE_EVENT_TAG];
  if (!payload || typeof payload !== "object") return null;
  const { kind, text, style } = payload as Record<string, unknown>;
  if (kind !== "fallback_notice" || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return {
    // Notices embed the provider's exception text, which can run to pages.
    text:
      trimmed.length > MAX_NOTICE_LENGTH
        ? `${trimmed.slice(0, MAX_NOTICE_LENGTH - 1)}…`
        : trimmed,
    level:
      (typeof style === "string" ? LEVEL_BY_STYLE[style] : undefined) ??
      "warning",
  };
}
