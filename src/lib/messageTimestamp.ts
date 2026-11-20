// When a message was sent, for the small time label under chat messages.
//
// The backend stamps every message it persists with
// `response_metadata.evo_created_at`, an ISO-8601 UTC string, set once.
// Threads from before that stamp only have the provider's own field, and
// only OpenRouter replies carry one: `response_metadata.created`, in Unix
// seconds. Streamed chunks carry neither; the stamp shows up once the
// model step's values land.

/**
 * The time a message was created, or null when the message carries none.
 */
export function getMessageTimestamp(
  message: { response_metadata?: Record<string, unknown> } | undefined
): Date | null {
  const meta = message?.response_metadata;
  if (!meta) return null;

  const stamped = meta.evo_created_at;
  if (typeof stamped === "string") {
    const ms = Date.parse(stamped);
    if (Number.isFinite(ms)) return new Date(ms);
  }

  const created = meta.created;
  if (typeof created === "number") {
    const date = new Date(created * 1000);
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}

/**
 * `HH:MM:SS` and the date, both in the reader's own format and the local
 * timezone.
 */
export function formatTimestamp(date: Date, locales?: string): string {
  const time = new Intl.DateTimeFormat(locales, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const day = new Intl.DateTimeFormat(locales, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return `${time} ${day}`;
}
