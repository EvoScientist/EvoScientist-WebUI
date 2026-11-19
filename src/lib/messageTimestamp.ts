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
  if (typeof created === "number" && Number.isFinite(created)) {
    return new Date(created * 1000);
  }
  return null;
}

/**
 * `HH:MM:SS DD/MM/YYYY` in the local timezone.
 */
export function formatTimestamp(date: Date): string {
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(pad)
    .join(":");
  const day = [
    pad(date.getDate()),
    pad(date.getMonth() + 1),
    date.getFullYear(),
  ].join("/");
  return `${time} ${day}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
