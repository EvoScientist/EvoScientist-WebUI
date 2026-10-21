import { describe, expect, it } from "vitest";
import {
  applyEdit,
  currentText,
  draftErrors,
  fieldLabel,
  keyedBaseUrlErrors,
  keyIsSet,
  modelForProvider,
  patchBody,
  readOnlyReason,
  saveErrorText,
  sendableEdits,
  sourceNote,
  stepOfField,
  testKeyErrorText,
  wizardSteps,
} from "@/lib/settingsForm";
import type { ProviderInfo, SettingsPayload } from "@/lib/settings";

const openai: ProviderInfo = {
  label: "OpenAI",
  key_field: "openai_api_key",
  base_url_field: null,
  needs_key: true,
  needs_base_url: false,
  has_check: true,
  lists_models: false,
};
const ollama: ProviderInfo = {
  label: "Ollama",
  key_field: null,
  base_url_field: "ollama_base_url",
  needs_key: false,
  needs_base_url: false,
  has_check: true,
  lists_models: true,
};
const customOpenai: ProviderInfo = {
  label: "OpenAI-compatible",
  key_field: "custom_openai_api_key",
  base_url_field: "custom_openai_base_url",
  needs_key: true,
  needs_base_url: true,
  has_check: true,
  lists_models: true,
};

const payload: SettingsPayload = {
  settings: {
    provider: "openai",
    model: "gpt-5",
    openai_api_key: { set: true, hint: "…abcd" },
    ollama_base_url: "",
    mirror: "default",
  },
  sources: {},
  read_only: [],
  providers: { openai, ollama, "custom-openai": customOpenai },
  setup_needed: false,
  restart_required: false,
  restart_fields: [],
  revision: "rev-1",
  config_error: null,
};

describe("applyEdit", () => {
  it("keeps a stored key when its field is emptied", () => {
    const typed = applyEdit({}, payload, "openai_api_key", "sk-new", {
      secret: true,
    });
    expect(typed).toEqual({ openai_api_key: "sk-new" });
    expect(
      applyEdit(typed, payload, "openai_api_key", "", { secret: true })
    ).toEqual({});
  });

  it("removes a key only on an explicit null", () => {
    expect(
      applyEdit({}, payload, "openai_api_key", null, { secret: true })
    ).toEqual({ openai_api_key: null });
  });

  it("drops a plain field typed back to its saved value", () => {
    const changed = applyEdit({}, payload, "model", "gpt-4", { secret: false });
    expect(changed).toEqual({ model: "gpt-4" });
    expect(
      applyEdit(changed, payload, "model", "gpt-5", { secret: false })
    ).toEqual({});
  });

  it("sends an emptied plain field as null, back to its default", () => {
    expect(applyEdit({}, payload, "model", "", { secret: false })).toEqual({
      model: null,
    });
  });
});

describe("patchBody", () => {
  it("holds only the changed fields and the revision the page read", () => {
    let edits = applyEdit({}, payload, "model", "gpt-4", { secret: false });
    edits = applyEdit(edits, payload, "openai_api_key", "", { secret: true });
    expect(patchBody(edits, "rev-1")).toEqual({
      model: "gpt-4",
      revision: "rev-1",
    });
  });
});

describe("sendableEdits", () => {
  const dashscope: ProviderInfo = {
    ...openai,
    label: "DashScope",
    key_field: "dashscope_api_key",
  };
  const providers = {
    ...payload.providers,
    dashscope,
    "dashscope-code": { ...dashscope, label: "DashScope Coding Plan" },
  };

  it("leaves out a key typed for a provider that is no longer selected", () => {
    expect(
      sendableEdits(
        { openai_api_key: "sk-wrong", provider: "ollama", model: "m" },
        providers,
        "ollama"
      )
    ).toEqual({ provider: "ollama", model: "m" });
  });

  it("keeps the selected provider's key and base URL, and other settings", () => {
    const edits = {
      custom_openai_api_key: "k",
      custom_openai_base_url: "http://h/v1",
      tavily_api_key: "t",
      mirror: "cn",
    };
    expect(sendableEdits(edits, providers, "custom-openai")).toEqual(edits);
  });

  it("keeps a key field two providers share", () => {
    expect(
      sendableEdits({ dashscope_api_key: "k" }, providers, "dashscope-code")
    ).toEqual({ dashscope_api_key: "k" });
  });
});

describe("currentText", () => {
  it("shows the unsaved value over the saved one", () => {
    expect(currentText(payload, {}, "model")).toBe("gpt-5");
    expect(currentText(payload, { model: "x" }, "model")).toBe("x");
    expect(currentText(payload, { model: null }, "model")).toBe("");
  });
});

describe("draftErrors", () => {
  it("refuses a changed URL that kept its hidden user and password", () => {
    expect(
      draftErrors({ http_proxy: "http://***@proxy.example:3129" })
    ).toHaveProperty("http_proxy");
  });

  it("accepts a URL typed in full", () => {
    expect(
      draftErrors({ http_proxy: "http://me:pw@proxy.example:3129" })
    ).toEqual({});
  });

  it("asks for a model instead of removing it", () => {
    expect(draftErrors({ model: null })).toHaveProperty("model");
    expect(draftErrors({ model: "gpt-5" })).toEqual({});
  });
});

describe("modelForProvider", () => {
  it("keeps the current model, then the saved one, when the provider lists it", () => {
    expect(modelForProvider(["gpt-5", "x"], openai, ["gpt-4.1", "gpt-5"])).toBe(
      "gpt-5"
    );
    expect(modelForProvider(["x", "gpt-5"], openai, ["gpt-4.1", "gpt-5"])).toBe(
      "gpt-5"
    );
  });

  it("takes the provider's first model when it lists neither", () => {
    expect(
      modelForProvider(["claude-sonnet-5-5"], openai, ["gpt-4.1", "gpt-5"])
    ).toBe("gpt-4.1");
  });

  it("leaves the choice to the user where the check lists the models", () => {
    expect(
      modelForProvider(["claude-sonnet-5-5"], customOpenai, ["gpt-6-luna"])
    ).toBe("");
    expect(modelForProvider(["claude-sonnet-5-5"], ollama, [])).toBe("");
  });
});

describe("keyedBaseUrlErrors", () => {
  const withCustom: SettingsPayload = {
    ...payload,
    settings: {
      ...payload.settings,
      custom_openai_api_key: { set: true, hint: "…wxyz" },
      custom_openai_base_url: "http://a.example/v1",
    },
  };

  it("asks for the saved key again when its endpoint's address changes", () => {
    expect(
      keyedBaseUrlErrors(
        { custom_openai_base_url: "http://b.example/v1" },
        withCustom
      )
    ).toHaveProperty("custom_openai_api_key");
    expect(
      keyedBaseUrlErrors({ custom_openai_base_url: null }, withCustom)
    ).toHaveProperty("custom_openai_api_key");
  });

  it("is satisfied by a new key or its removal", () => {
    for (const key of ["sk-new-0000", null]) {
      expect(
        keyedBaseUrlErrors(
          {
            custom_openai_base_url: "http://b.example/v1",
            custom_openai_api_key: key,
          },
          withCustom
        )
      ).toEqual({});
    }
  });

  it("asks nothing without a saved key, or for an address without a key", () => {
    expect(
      keyedBaseUrlErrors(
        { custom_openai_base_url: "http://b.example/v1" },
        payload
      )
    ).toEqual({});
    expect(
      keyedBaseUrlErrors({ ollama_base_url: "http://h:11434" }, withCustom)
    ).toEqual({});
  });
});

describe("wizardSteps", () => {
  it("asks for the model before the key where the registry lists models", () => {
    expect(wizardSteps(openai)).toEqual([
      "provider",
      "model",
      "key",
      "tavily",
      "folder",
      "summary",
    ]);
  });

  it("asks for the key or base URL first where the check lists models", () => {
    expect(wizardSteps(ollama)).toEqual([
      "provider",
      "key",
      "model",
      "tavily",
      "folder",
      "summary",
    ]);
    expect(wizardSteps(customOpenai).slice(0, 3)).toEqual([
      "provider",
      "key",
      "model",
    ]);
  });

  it("places a save error on the step of its field", () => {
    expect(stepOfField("openai_api_key", openai)).toBe("key");
    expect(stepOfField("mirror", openai)).toBe("folder");
    expect(stepOfField("model", openai)).toBe("model");
  });
});

describe("labels", () => {
  it("names provider fields and restart entries", () => {
    expect(fieldLabel("openai_api_key", payload.providers)).toBe(
      "OpenAI API key"
    );
    expect(fieldLabel("ollama_base_url", payload.providers)).toBe(
      "Ollama base URL"
    );
    expect(fieldLabel("mcp.yaml", payload.providers)).toBe(
      "MCP servers (mcp.yaml)"
    );
    expect(fieldLabel("show_thinking", payload.providers)).toBe(
      "Show thinking"
    );
  });

  it("names where an override comes from", () => {
    expect(sourceNote({ source: "env", shadowed: true })).toBe(
      "an environment variable"
    );
    expect(
      sourceNote({ source: "dotenv", path: "/w/.env", shadowed: true })
    ).toBe("the .env file at /w/.env");
    expect(sourceNote({ source: "cli", shadowed: true })).toMatch(/flag/);
  });
});

describe("saveErrorText", () => {
  it("reads a 409 by its error", () => {
    expect(saveErrorText({ error: "revision_mismatch" }, 409)).toMatch(
      /changed elsewhere/
    );
    expect(saveErrorText({ error: "config_locked" }, 409)).toMatch(
      /EvoSci onboard/
    );
    expect(
      saveErrorText(
        {
          error: "config_unreadable",
          path: "/c/config.yaml",
          detail: "line 3",
        },
        409
      )
    ).toMatch(/\/c\/config\.yaml.*line 3/);
  });

  it("explains the relay's refusals and anything else by status", () => {
    expect(saveErrorText({ error: "secret_missing" }, 503)).toMatch(
      /local secret/
    );
    expect(saveErrorText(null, 500)).toBe("Saving failed (HTTP 500).");
  });

  it("says why a page is read-only", () => {
    expect(readOnlyReason({ writable: true })).toBeNull();
    expect(
      readOnlyReason({ writable: false, reason: "other_backend" })
    ).toMatch(/machine that runs it/);
  });
});

describe("keyIsSet", () => {
  it("counts a saved key and one set elsewhere", () => {
    expect(keyIsSet(payload, "openai_api_key")).toBe(true);
    expect(
      keyIsSet(
        {
          ...payload,
          settings: { ...payload.settings, openai_api_key: { set: false } },
          sources: { openai_api_key: { source: "env", shadowed: true } },
        },
        "openai_api_key"
      )
    ).toBe(true);
    expect(keyIsSet(payload, "custom_openai_api_key")).toBe(false);
  });
});

describe("testKeyErrorText", () => {
  it("names what each error is about", () => {
    expect(testKeyErrorText({ base_url: "must be an http or https URL" })).toBe(
      "Address: must be an http or https URL"
    );
  });
});
