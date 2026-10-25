import { describe, expect, it } from "vitest";
import { parseModelCommand } from "./modelCommand";

describe("parseModelCommand", () => {
  it("returns null for non-/model inputs", () => {
    expect(parseModelCommand("")).toBeNull();
    expect(parseModelCommand("hello")).toBeNull();
    expect(parseModelCommand("/models")).toBeNull();
    expect(parseModelCommand("model reset")).toBeNull();
  });

  it("returns 'show' for a bare /model", () => {
    expect(parseModelCommand("/model")).toEqual({ kind: "show" });
  });

  it("tolerates surrounding and trailing whitespace on /model", () => {
    expect(parseModelCommand("  /model  ")).toEqual({ kind: "show" });
    expect(parseModelCommand("/model   ")).toEqual({ kind: "show" });
  });

  it("returns 'reset' for /model reset", () => {
    expect(parseModelCommand("/model reset")).toEqual({ kind: "reset" });
  });

  it("treats /model reset case-insensitively", () => {
    expect(parseModelCommand("/model RESET")).toEqual({ kind: "reset" });
    expect(parseModelCommand("/model Reset")).toEqual({ kind: "reset" });
  });

  it("does NOT treat /model reset <extra> as a reset", () => {
    // Two-arg form; falls through to `set` with model="reset" provider="foo".
    expect(parseModelCommand("/model reset foo")).toEqual({
      kind: "set",
      model: "reset",
      provider: "foo",
    });
  });

  it("parses /model <name> as a set without provider", () => {
    expect(parseModelCommand("/model claude-sonnet-4-6")).toEqual({
      kind: "set",
      model: "claude-sonnet-4-6",
      provider: undefined,
    });
  });

  it("parses /model <name> <provider> as a set with provider", () => {
    expect(parseModelCommand("/model gpt-5.5 openai")).toEqual({
      kind: "set",
      model: "gpt-5.5",
      provider: "openai",
    });
  });

  it("collapses runs of whitespace between args", () => {
    expect(parseModelCommand("/model   gpt-5.5    openai  ")).toEqual({
      kind: "set",
      model: "gpt-5.5",
      provider: "openai",
    });
  });

  it("returns null when there are more than two args", () => {
    expect(parseModelCommand("/model a b c")).toBeNull();
    expect(parseModelCommand("/model a b c d")).toBeNull();
  });

  it("requires a space after /model (rejects /modelfoo)", () => {
    expect(parseModelCommand("/modelfoo")).toBeNull();
    expect(parseModelCommand("/model-picker")).toBeNull();
  });

  it("preserves the model name verbatim (no lowercasing)", () => {
    // Middleware accepts anything init_chat_model recognises; power users
    // should not have their casing rewritten.
    expect(parseModelCommand("/model Claude-Sonnet-4-6")).toEqual({
      kind: "set",
      model: "Claude-Sonnet-4-6",
      provider: undefined,
    });
  });
});
