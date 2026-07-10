import { describe, expect, it } from "vitest";
import { formatModel } from "./model";

describe("formatModel", () => {
  it("returns null for empty or non-string input", () => {
    expect(formatModel(undefined)).toBeNull();
    expect(formatModel(null)).toBeNull();
    expect(formatModel("")).toBeNull();
    expect(formatModel("   ")).toBeNull();
    expect(formatModel(42)).toBeNull();
  });

  it("strips a provider/ prefix and uses it as provider when none is given", () => {
    expect(formatModel("anthropic/claude-4.8-opus")).toEqual({
      name: "claude-4.8-opus",
      provider: "Anthropic",
    });
  });

  it("strips a trailing YYYYMMDD date stamp", () => {
    expect(formatModel("anthropic/claude-4.8-opus-20260528")).toEqual({
      name: "claude-4.8-opus",
      provider: "Anthropic",
    });
  });

  it("prefers explicit provider over the prefix", () => {
    expect(formatModel("anthropic/claude-4.8-opus", "bedrock")).toEqual({
      name: "claude-4.8-opus",
      provider: "Bedrock",
    });
  });

  it("returns null-ish provider when neither prefix nor explicit is set", () => {
    expect(formatModel("claude-4.8-opus")).toEqual({
      name: "claude-4.8-opus",
      provider: null,
    });
  });

  it("keeps only the segment after the LAST slash", () => {
    expect(formatModel("org/anthropic/claude-4.8-opus")).toEqual({
      name: "claude-4.8-opus",
      provider: "Org/anthropic",
    });
  });

  it("does not strip a non-8-digit date suffix", () => {
    expect(formatModel("claude-4.8-opus-2026")).toEqual({
      name: "claude-4.8-opus-2026",
      provider: null,
    });
  });
});
