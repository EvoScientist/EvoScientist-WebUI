import { describe, expect, it } from "vitest";
import { formatModel, replyModel } from "./model";

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

describe("replyModel", () => {
  it("reads the provider's id and provider from response_metadata", () => {
    expect(
      replyModel({ model_name: "z-ai/glm-5.3", model_provider: "openrouter" })
    ).toEqual({
      name: "glm-5.3",
      provider: "Openrouter",
      raw: "z-ai/glm-5.3 (openrouter)",
    });
  });

  it("keeps a variant suffix the provider added, and shows it raw too", () => {
    expect(
      replyModel({ model_name: "GLM-V5.2-32K", model_provider: "openai" })
    ).toEqual({
      name: "GLM-V5.2-32K",
      provider: "Openai",
      raw: "GLM-V5.2-32K (openai)",
    });
  });

  it("falls back to `model` and leaves the provider out when none is given", () => {
    expect(replyModel({ model: "llama3" })).toEqual({
      name: "llama3",
      provider: null,
      raw: "llama3",
    });
  });

  it("returns null for a reply without a model name", () => {
    expect(replyModel(undefined)).toBeNull();
    expect(replyModel({ model_provider: "openrouter" })).toBeNull();
  });
});
