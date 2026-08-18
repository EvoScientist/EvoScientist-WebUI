import { describe, expect, it } from "vitest";
import { formatTimestamp, getMessageTimestamp } from "./messageTimestamp";

describe("getMessageTimestamp", () => {
  it("reads the backend stamp", () => {
    const ts = getMessageTimestamp({
      response_metadata: { evo_created_at: "2026-11-19T14:32:05.123Z" },
    });
    expect(ts?.toISOString()).toBe("2026-11-19T14:32:05.123Z");
  });

  it("prefers the backend stamp over the provider's created", () => {
    const ts = getMessageTimestamp({
      response_metadata: {
        evo_created_at: "2026-11-19T14:32:05.000Z",
        created: 1_700_000_000,
      },
    });
    expect(ts?.toISOString()).toBe("2026-11-19T14:32:05.000Z");
  });

  it("falls back to created in Unix seconds", () => {
    const ts = getMessageTimestamp({
      response_metadata: { created: 1_700_000_000 },
    });
    expect(ts?.getTime()).toBe(1_700_000_000_000);
  });

  it("falls back to created when the stamp doesn't parse", () => {
    const ts = getMessageTimestamp({
      response_metadata: { evo_created_at: "not a date", created: 1 },
    });
    expect(ts?.getTime()).toBe(1000);
  });

  it("returns null when the message carries no time", () => {
    expect(getMessageTimestamp(undefined)).toBeNull();
    expect(getMessageTimestamp({})).toBeNull();
    expect(getMessageTimestamp({ response_metadata: {} })).toBeNull();
    expect(
      getMessageTimestamp({ response_metadata: { created: "1700000000" } })
    ).toBeNull();
  });
});

describe("formatTimestamp", () => {
  it("formats local time as HH:MM:SS", () => {
    expect(formatTimestamp(new Date(2026, 10, 19, 9, 5, 7))).toBe("09:05:07");
  });
});
