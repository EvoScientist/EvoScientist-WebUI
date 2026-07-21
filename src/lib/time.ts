export function formatTime(date: Date, now = new Date()): string {
  if (!Number.isFinite(date.getTime())) return "—";

  const bucket = timeBucketFor(date, now);

  if (bucket === "today") {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  }
  if (bucket === "yesterday") return "Yesterday";
  if (bucket === "week") {
    return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export type TimeBucket = "today" | "yesterday" | "week" | "older";

export function timeBucketFor(updatedAt: Date, now: Date): TimeBucket {
  if (
    !Number.isFinite(updatedAt.getTime()) ||
    !Number.isFinite(now.getTime())
  ) {
    return "older";
  }

  // Compare local calendar dates rather than elapsed 24-hour windows. A
  // thread from 23:59 belongs under Yesterday at 00:01, and UTC-normalizing
  // the local date parts keeps this stable across daylight-saving changes.
  const calendarDay = (date: Date) =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.floor(
    (calendarDay(now) - calendarDay(updatedAt)) / (1000 * 60 * 60 * 24)
  );
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "older";
}

export function formatFullTime(date: Date): string {
  if (!Number.isFinite(date.getTime())) return "Unknown time";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(date);
}
