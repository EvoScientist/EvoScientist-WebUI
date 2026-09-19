import { describe, expect, it } from "vitest";
import { parseFallbackNotice } from "./middlewareEvents";

const wire = (payload: unknown) => ({ evoscientist: payload });

describe("parseFallbackNotice", () => {
  it("reads a fallback notice and maps the backend style to a level", () => {
    expect(
      parseFallbackNotice(
        wire({
          kind: "fallback_notice",
          text: "  -> Falling back to gpt-6-astra (openai) due to: APIError: 529",
          style: "yellow",
        })
      )
    ).toEqual({
      text: "-> Falling back to gpt-6-astra (openai) due to: APIError: 529",
      level: "warning",
    });
    expect(
      parseFallbackNotice(
        wire({ kind: "fallback_notice", text: "ok", style: "green" })
      )?.level
    ).toBe("success");
    expect(
      parseFallbackNotice(
        wire({ kind: "fallback_notice", text: "bad", style: "red" })
      )?.level
    ).toBe("error");
  });

  it("treats a missing or unknown style as a warning", () => {
    expect(
      parseFallbackNotice(wire({ kind: "fallback_notice", text: "x" }))?.level
    ).toBe("warning");
    expect(
      parseFallbackNotice(
        wire({ kind: "fallback_notice", text: "x", style: "magenta" })
      )?.level
    ).toBe("warning");
  });

  it("caps a long provider error so the toast stays readable", () => {
    const notice = parseFallbackNotice(
      wire({ kind: "fallback_notice", text: "e".repeat(1000) })
    );
    expect(notice?.text.length).toBeLessThanOrEqual(240);
    expect(notice?.text.endsWith("…")).toBe(true);
  });

  it("ignores other middleware kinds, other custom traffic and junk", () => {
    expect(
      parseFallbackNotice(wire({ kind: "tool_selection", selected: [] }))
    ).toBeNull();
    expect(parseFallbackNotice({ type: "subagent_started" })).toBeNull();
    expect(
      parseFallbackNotice(wire({ kind: "fallback_notice", text: "   " }))
    ).toBeNull();
    expect(
      parseFallbackNotice(wire({ kind: "fallback_notice", text: 42 }))
    ).toBeNull();
    expect(parseFallbackNotice(null)).toBeNull();
    expect(parseFallbackNotice("fallback_notice")).toBeNull();
  });
});
