/** Cron expression helpers for the Scheduled Tasks panel. */

export type Frequency = "daily" | "weekly" | "monthly" | "custom";

export interface ScheduleSpec {
  frequency: Frequency;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday (used when frequency === "weekly") */
  dayOfWeek: number;
  /** 1–28 (used when frequency === "monthly") */
  dayOfMonth: number;
  /** Raw cron string (used when frequency === "custom") */
  custom: string;
}

export const DEFAULT_SCHEDULE_SPEC: ScheduleSpec = {
  frequency: "daily",
  hour: 9,
  minute: 0,
  dayOfWeek: 1,
  dayOfMonth: 1,
  custom: "0 9 * * *",
};

export const DAY_NAMES = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function validateCronExpression(cron: string): string | null {
  const trimmed = cron.trim();
  if (!trimmed) return "Enter a cron expression.";
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return "Use five cron fields: minute hour day month weekday.";
  }
  return null;
}

export function specToCron(spec: ScheduleSpec): string {
  const minute = clampNumber(spec.minute, 0, 59);
  const hour = clampNumber(spec.hour, 0, 23);
  const dayOfWeek = clampNumber(spec.dayOfWeek, 0, 6);
  const dayOfMonth = clampNumber(spec.dayOfMonth, 1, 28);

  switch (spec.frequency) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${dayOfWeek}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    case "custom":
      return spec.custom.trim();
  }
  return `${minute} ${hour} * * *`;
}

// A field the visual builder can show: a plain number within range. A range
// (1-5), a list (1,15), a step (*/5), a name (MON) or an out-of-range value
// (31 for the builder's 1-28, 7 for Sunday) is not, so its cron stays custom.
function plainField(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/**
 * Parse a cron string back into a ScheduleSpec. Only schedules the builder
 * can write come back as daily / weekly / monthly; anything else stays a
 * custom cron, verbatim, so saving a task unchanged never changes when it
 * runs.
 */
export function cronToSpec(cron: string): ScheduleSpec {
  const parts = cron.trim().split(/\s+/);
  const fields = parts.length === 5 ? parts : null;
  const read = (index: number, min: number, max: number) =>
    fields ? plainField(fields[index], min, max) : null;
  const minute = read(0, 0, 59);
  const hour = read(1, 0, 23);
  // A custom cron still lends the builder the fields it can show, so
  // switching it to daily / weekly / monthly starts from them.
  const custom: ScheduleSpec = {
    frequency: "custom",
    custom: cron,
    minute: minute ?? DEFAULT_SCHEDULE_SPEC.minute,
    hour: hour ?? DEFAULT_SCHEDULE_SPEC.hour,
    dayOfMonth: read(2, 1, 28) ?? DEFAULT_SCHEDULE_SPEC.dayOfMonth,
    dayOfWeek: read(4, 0, 6) ?? DEFAULT_SCHEDULE_SPEC.dayOfWeek,
  };
  if (!fields || minute === null || hour === null) return custom;
  const [, , dom, month, dow] = fields;
  if (month !== "*") return custom;
  const time = { ...DEFAULT_SCHEDULE_SPEC, hour, minute };

  if (dom === "*" && dow === "*") return { ...time, frequency: "daily" };
  if (dom === "*") {
    const dayOfWeek = plainField(dow, 0, 6);
    return dayOfWeek === null
      ? custom
      : { ...time, frequency: "weekly", dayOfWeek };
  }
  if (dow === "*") {
    const dayOfMonth = plainField(dom, 1, 28);
    return dayOfMonth === null
      ? custom
      : { ...time, frequency: "monthly", dayOfMonth };
  }
  return custom;
}

/** Human-readable summary of a cron expression. */
export function cronLabel(cron: string): string {
  const spec = cronToSpec(cron);
  const time = `${String(spec.hour).padStart(2, "0")}:${String(
    spec.minute
  ).padStart(2, "0")}`;
  switch (spec.frequency) {
    case "daily":
      return `Every day at ${time}`;
    case "weekly":
      return `Every ${DAY_NAMES[spec.dayOfWeek]} at ${time}`;
    case "monthly":
      return `Monthly on day ${spec.dayOfMonth} at ${time}`;
    default:
      return cron;
  }
}

/** The browser's IANA time zone, or undefined when the browser reports none. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** A cron stored without a time zone runs on UTC (the server's default). */
export function timeZoneLabel(timezone: string | null | undefined): string {
  return timezone ? timezone.replace(/_/g, " ") : "UTC";
}

/** Schedule summary plus the time zone it runs in. */
export function scheduleLabel(
  cron: string,
  timezone: string | null | undefined
): string {
  return `${cronLabel(cron)} · ${timeZoneLabel(timezone)}`;
}

/** Format a next_run_date ISO string into a short relative label. */
export function nextRunLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diff = d.getTime() - now;
  if (diff < 0) return "Overdue";
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(diff / 3_600_000);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(diff / 86_400_000);
  return `in ${days}d`;
}
