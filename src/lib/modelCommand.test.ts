import { describe, expect, it } from "vitest";
import {
  defaultModelPick,
  isDefaultPick,
  parseModelCommand,
  pinnedModelHint,
  storedModelPick,
} from "./modelCommand";

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

describe("defaultModelPick", () => {
  it("turns the registry default into a pick", () => {
    expect(defaultModelPick({ name: "m-0", provider: "p-0" })).toEqual({
      model: "m-0",
      model_provider: "p-0",
    });
    expect(defaultModelPick({ name: "m-0", provider: null })).toEqual({
      model: "m-0",
    });
  });

  it("returns null without a default", () => {
    expect(defaultModelPick(null)).toBeNull();
    expect(defaultModelPick({ name: "", provider: "p-0" })).toBeNull();
  });
});

describe("isDefaultPick", () => {
  const def = { name: "m-0", provider: "p-0" };

  it("matches the same model and provider", () => {
    expect(isDefaultPick({ model: "m-0", model_provider: "p-0" }, def)).toBe(
      true
    );
  });

  it("matches a pick without a provider only to a default without one", () => {
    expect(
      isDefaultPick({ model: "m-0" }, { name: "m-0", provider: null })
    ).toBe(true);
    // The core runs a bare name on its own registry provider, not p-0.
    expect(isDefaultPick({ model: "m-0" }, def)).toBe(false);
    expect(
      isDefaultPick(
        { model: "m-0", model_provider: "p-0" },
        { name: "m-0", provider: null }
      )
    ).toBe(false);
  });

  it("does not match another model or provider, or a missing side", () => {
    expect(isDefaultPick({ model: "m-1", model_provider: "p-0" }, def)).toBe(
      false
    );
    expect(isDefaultPick({ model: "m-0", model_provider: "p-1" }, def)).toBe(
      false
    );
    expect(isDefaultPick(null, def)).toBe(false);
    expect(isDefaultPick({ model: "m-0" }, null)).toBe(false);
  });
});

describe("pinnedModelHint", () => {
  const defaultModel = { name: "m-0", provider: "p-0" };

  it("names the thread's model and the default it would move to", () => {
    expect(
      pinnedModelHint({
        pick: { model: "m-2", model_provider: "p-1" },
        defaultModel,
      })
    ).toBe("This chat runs on m-2 (p-1). /model reset moves it to m-0 (p-0).");
    expect(
      pinnedModelHint({
        pick: { model: "m-2" },
        defaultModel: { name: "m-0", provider: null },
      })
    ).toBe("This chat runs on m-2. /model reset moves it to m-0.");
  });

  it("names a pick without a provider that the default has one for", () => {
    expect(pinnedModelHint({ pick: { model: "m-0" }, defaultModel })).toBe(
      "This chat runs on m-0. /model reset moves it to m-0 (p-0)."
    );
  });

  it("says nothing on the default, without a pick or without a default", () => {
    expect(
      pinnedModelHint({
        pick: { model: "m-0", model_provider: "p-0" },
        defaultModel,
      })
    ).toBeNull();
    expect(pinnedModelHint({ pick: null, defaultModel })).toBeNull();
    expect(
      pinnedModelHint({ pick: { model: "m-2" }, defaultModel: null })
    ).toBeNull();
  });
});

describe("storedModelPick", () => {
  it("reads a thread's pick from its metadata", () => {
    expect(
      storedModelPick({
        model_override: { model: "m-2", model_provider: "p-1" },
      })
    ).toEqual({ model: "m-2", model_provider: "p-1" });
    expect(storedModelPick({ model_override: { model: "m-2" } })).toEqual({
      model: "m-2",
      model_provider: undefined,
    });
  });

  it("returns null without a pick, or a cleared or broken one", () => {
    expect(storedModelPick({})).toBeNull();
    expect(storedModelPick({ model_override: null })).toBeNull();
    expect(storedModelPick({ model_override: { model: 3 } })).toBeNull();
  });
});
