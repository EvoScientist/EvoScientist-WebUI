import { describe, expect, it } from "vitest";
import { modelPageEntries, modelPageModels } from "./modelPage";
import { COMMON_MODELS, type ModelOverride } from "./modelCommand";

const MODELS: ModelOverride[] = [
  { model: "gpt-5.5", model_provider: "openai" },
  { model: "gpt-5.5", model_provider: "openrouter" },
  { model: "claude-sonnet-5-5", model_provider: "anthropic" },
];
const DEFAULT = { name: "claude-sonnet-5-5", provider: "anthropic" };
const OPENAI: ModelOverride = { model: "gpt-5.5", model_provider: "openai" };

const entries = (o: Partial<Parameters<typeof modelPageEntries>[0]> = {}) =>
  modelPageEntries({
    models: MODELS,
    override: null,
    defaultEntry: DEFAULT,
    filter: "",
    ...o,
  });

describe("modelPageEntries", () => {
  it("marks the override as current, matching model and provider", () => {
    expect(entries({ override: OPENAI }).map((r) => r.current)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("marks the default as current only without an override", () => {
    expect(entries().map((r) => r.current)).toEqual([false, false, true]);
    expect(entries({ override: OPENAI })[2].current).toBe(false);
  });

  it("always marks the backend default as default", () => {
    expect(entries({ override: OPENAI }).map((r) => r.isDefault)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("filters on model or provider, ignoring case and outer spaces", () => {
    expect(
      entries({ filter: " OpenAI " }).map((r) => `${r.model}|${r.provider}`)
    ).toEqual(["gpt-5.5|openai"]);
    expect(entries({ filter: "SONNET" }).map((r) => r.model)).toEqual([
      "claude-sonnet-5-5",
    ]);
  });

  it("keeps the registry's order and each row's provider", () => {
    expect(entries().map((r) => [r.model, r.provider])).toEqual([
      ["gpt-5.5", "openai"],
      ["gpt-5.5", "openrouter"],
      ["claude-sonnet-5-5", "anthropic"],
    ]);
  });
});

describe("modelPageModels", () => {
  it("uses the registry, in its order", () => {
    expect(
      modelPageModels([
        { name: "b", model_id: "b-1", provider: "p" },
        { name: "a", model_id: "a-1", provider: "q" },
      ])
    ).toEqual([
      { model: "b", model_provider: "p" },
      { model: "a", model_provider: "q" },
    ]);
  });

  it("falls back to the curated list when the registry is empty", () => {
    expect(modelPageModels([])).toEqual(
      COMMON_MODELS.map((m) => ({
        model: m.model,
        model_provider: m.model_provider,
      }))
    );
  });
});
