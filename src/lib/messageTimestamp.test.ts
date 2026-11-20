import { describe, expect, it, vi } from "vitest";
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
    expect(
      getMessageTimestamp({ response_metadata: { created: 1e13 } })
    ).toBeNull();
  });
});

describe("formatTimestamp", () => {
  it("formats the time and the date in the reader's own order", () => {
    const date = new Date(2026, 10, 5, 9, 5, 7);
    expect(formatTimestamp(date, "en-GB")).toBe("09:05:07 05/11/2026");
    expect(formatTimestamp(date, "en-US")).toBe("09:05:07 11/05/2026");
    expect(formatTimestamp(date, "zh-CN")).toBe("09:05:07 2026/11/05");
    expect(formatTimestamp(new Date(2027, 0, 3, 0, 0, 0), "en-GB")).toBe(
      "00:00:00 03/01/2027"
    );
  });

  it("uses the browser's locale by default", () => {
    const Real = Intl.DateTimeFormat;
    const made = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(function (
        locales?: Intl.LocalesArgument,
        options?: Intl.DateTimeFormatOptions
      ) {
        return new Real(locales, options);
      });
    try {
      formatTimestamp(new Date(2026, 10, 5, 9, 5, 7));
      expect(made).toHaveBeenCalled();
      expect(made.mock.calls.map(([locales]) => locales)).toEqual(
        made.mock.calls.map(() => undefined)
      );
    } finally {
      made.mockRestore();
    }
  });

  it("keeps the time and the date in the same digits", () => {
    const date = new Date(2026, 10, 5, 9, 5, 7);
    expect(formatTimestamp(date, "ar-EG")).not.toMatch(/[0-9]/);
  });
});
