// @vitest-environment jsdom
//
// The Setup view, its wizard, the chat notice and the first-run gate against
// a fake EvoScientist settings API (GET /api/settings on the deployment) and
// a fake WebUI relay (/api/settings/access, PATCH /api/settings,
// POST /api/settings/test-key).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { SetupView } from "@/app/components/SetupView";
import { SetupNotice } from "@/app/components/SetupNotice";
import { useSettings } from "@/app/hooks/useSettings";
import { useSetupGate } from "@/app/hooks/useSetupGate";
import { deferSetup, resetSetupDeferral } from "@/lib/setupDeferral";

// jsdom has no scrollIntoView; Radix Select calls it on the item it focuses
// when the provider list opens.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

const DEPLOYMENT = "http://127.0.0.1:6174";
const INSTANCE = "0123456789abcdef";

vi.mock("@/providers/ClientProvider", () => ({
  useDeployment: () => ({ deploymentUrl: DEPLOYMENT, apiKey: "" }),
}));

vi.mock("@/app/hooks/useAvailableModels", () => ({
  useAvailableModels: () => ({
    registry: {
      entries: [
        { name: "gpt-5", model_id: "gpt-5", provider: "openai" },
        { name: "claude-x", model_id: "claude-x", provider: "anthropic" },
      ],
      defaultEntry: null,
    },
    loading: false,
    error: null,
  }),
  refreshModelRegistry: vi.fn(),
}));

const PROVIDERS = {
  openai: {
    label: "OpenAI",
    key_field: "openai_api_key",
    base_url_field: null,
    needs_key: true,
    needs_base_url: false,
    has_check: true,
    lists_models: false,
  },
  ollama: {
    label: "Ollama",
    key_field: null,
    base_url_field: "ollama_base_url",
    needs_key: false,
    needs_base_url: false,
    has_check: true,
    lists_models: true,
  },
};

function settings(extra: Record<string, unknown> = {}) {
  return {
    settings: {
      provider: "openai",
      model: "gpt-5",
      openai_api_key: { set: true, hint: "…abcd" },
      tavily_api_key: { set: false },
      ollama_base_url: "",
      default_workdir: "",
      mirror: "default",
    },
    sources: {},
    read_only: [],
    providers: PROVIDERS,
    setup_needed: false,
    restart_required: false,
    restart_fields: [],
    revision: "rev-1",
    config_error: null,
    instance: INSTANCE,
    ...extra,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

// The fake servers. Tests replace members to change an answer.
const server = {
  settings: settings() as Record<string, unknown>,
  access: {
    writable: true,
    port: 6174,
    instance: INSTANCE,
    revision: "rev-1",
  } as Record<string, unknown>,
  patch: vi.fn((_body: Record<string, unknown>) =>
    json({
      revision: "rev-2",
      changed: [],
      restart_required: false,
      restart_fields: [],
      warnings: {},
    })
  ),
  testKey: vi.fn((_body: Record<string, unknown>) =>
    json({ ok: true, status: "valid", message: "" })
  ),
  gets: 0,
};

beforeEach(() => {
  // The gate keeps a pending leave when it unmounts, and RTL's cleanup runs
  // after this file's afterEach: start each test without a record or a view
  // in the address bar.
  resetSetupDeferral();
  window.history.replaceState(null, "", "/");
  server.settings = settings();
  server.access = {
    writable: true,
    port: 6174,
    instance: INSTANCE,
    revision: "rev-1",
  };
  server.gets = 0;
  server.patch.mockClear();
  server.testKey.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url === `${DEPLOYMENT}/api/settings` && method === "GET") {
        server.gets += 1;
        return json(server.settings);
      }
      if (url === "/api/settings/access") return json(server.access);
      if (url === "/api/settings" && method === "PATCH") {
        return server.patch(body);
      }
      if (url === "/api/settings/test-key") return server.testKey(body);
      throw new Error(`unexpected fetch ${method} ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSetupDeferral();
  delete window.evoscientistDesktop;
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

function renderView(onClose = vi.fn(), entry: "setup" | "settings" = "setup") {
  const onSaveUrl = vi.fn();
  const onFormShown = vi.fn();
  render(
    <SetupView
      entry={entry}
      onClose={onClose}
      onSaveDeploymentUrl={onSaveUrl}
      onFormShown={onFormShown}
    />,
    { wrapper }
  );
  return { onClose, onSaveUrl, onFormShown };
}

const renderSettingsPage = () => renderView(vi.fn(), "settings");

const keyInput = () =>
  screen.getByLabelText("OpenAI API key") as HTMLInputElement;

// The provider is picked from an in-page list (a Radix Select, like the
// model's menu): open it, then choose the option by the name it shows.
async function chooseProvider(label: string) {
  fireEvent.click(await screen.findByLabelText("Provider"));
  fireEvent.click(await screen.findByRole("option", { name: label }));
}

describe("the Setup form", () => {
  // The same in-page list as the model's menu, and pick-only: a provider
  // EvoScientist does not list cannot be typed in.
  it("picks the provider from an in-page list, not by typing", async () => {
    renderView();
    const trigger = await screen.findByLabelText("Provider");
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    const list = await screen.findByRole("listbox");
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent)
    ).toEqual(["OpenAI", "Ollama"]);
    fireEvent.click(within(list).getByRole("option", { name: "Ollama" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Provider").textContent).toContain("Ollama")
    );
  });

  // `undefined` would make Radix Select uncontrolled and keep the discarded
  // pick on screen; an empty saved provider must show the placeholder again.
  it("shows no provider again after Discard when none is saved", async () => {
    server.settings = settings({
      settings: { ...settings().settings, provider: "" },
    });
    renderView();
    await chooseProvider("OpenAI");
    expect(screen.getByLabelText("Provider").textContent).toContain("OpenAI");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Provider").textContent).toContain(
        "Choose a provider"
      )
    );
  });

  // Inside the form Radix renders a hidden native <select>; the option for an
  // unknown saved provider mounts in the same commit as the value, so that
  // select reports "" once. Taken as a pick, it would clear provider and model.
  it("goes back to an unknown saved provider on Discard", async () => {
    server.settings = settings({
      settings: { ...settings().settings, provider: "gone-provider" },
    });
    renderView();
    await chooseProvider("OpenAI");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Provider").textContent).toContain(
        "gone-provider"
      )
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Discard changes",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it("makes no edits when a re-read brings an unknown provider", async () => {
    renderView();
    await screen.findByLabelText("OpenAI API key");
    server.settings = settings({
      settings: { ...settings().settings, provider: "gone-provider" },
      revision: "rev-2",
    });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Provider").textContent).toContain(
        "gone-provider"
      )
    );
    await act(async () => {});
    expect(
      (
        screen.getByRole("button", {
          name: "Discard changes",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it("shows a stored key as its hint and keeps the field empty", async () => {
    renderView();
    await screen.findByText("Saved: …abcd");
    expect(keyInput().value).toBe("");
    expect(keyInput().type).toBe("password");
    expect(keyInput().autocomplete).toBe("off");
  });

  it("sends only the changed fields with the revision it read", async () => {
    renderView();
    const model = (await screen.findByLabelText("Model")) as HTMLInputElement;
    fireEvent.change(model, { target: { value: "gpt-4.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.patch).toHaveBeenCalledOnce());
    expect(server.patch.mock.calls[0][0]).toEqual({
      model: "gpt-4.1",
      revision: "rev-1",
    });
  });

  it("sends a key only when typed, and clears it after the save", async () => {
    renderView();
    await screen.findByText("Saved: …abcd");
    fireEvent.change(keyInput(), { target: { value: "sk-new-key-1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.patch).toHaveBeenCalledOnce());
    expect(server.patch.mock.calls[0][0]).toEqual({
      openai_api_key: "sk-new-key-1234",
      revision: "rev-1",
    });
    await waitFor(() => expect(keyInput().value).toBe(""));
  });

  it("removes a key only through Remove, as null", async () => {
    renderView();
    await screen.findByText("Saved: …abcd");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.patch).toHaveBeenCalledOnce());
    expect(server.patch.mock.calls[0][0]).toEqual({
      openai_api_key: null,
      revision: "rev-1",
    });
  });

  it("shows the backend's validation errors next to their field", async () => {
    server.patch.mockImplementationOnce(() =>
      json({ errors: { openai_api_key: "Invalid API key" } }, 400)
    );
    renderView();
    await screen.findByText("Saved: …abcd");
    fireEvent.change(keyInput(), { target: { value: "sk-bad-key-0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Invalid API key")).toBeTruthy();
    // The typed key stays for a correction.
    expect(keyInput().value).toBe("sk-bad-key-0000");
  });

  it("shows a save error for a field the form does not show", async () => {
    server.patch.mockImplementationOnce(() =>
      json({ errors: { show_thinking: "expected true or false" } }, 400)
    );
    renderView();
    const model = (await screen.findByLabelText("Model")) as HTMLInputElement;
    fireEvent.change(model, { target: { value: "gpt-4.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Show thinking: expected true or false")
    ).toBeTruthy();
  });

  it("reloads the values on revision_mismatch and asks to save again", async () => {
    server.patch.mockImplementationOnce(() =>
      json({ error: "revision_mismatch", revision: "rev-9" }, 409)
    );
    renderView();
    const model = (await screen.findByLabelText("Model")) as HTMLInputElement;
    const before = server.gets;
    fireEvent.change(model, { target: { value: "gpt-4.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/changed elsewhere/)).toBeTruthy();
    expect(server.gets).toBeGreaterThan(before);
    expect(model.value).toBe("gpt-4.1");
  });

  it("saves against the revision the edits started from, not one read later", async () => {
    renderView();
    const model = (await screen.findByLabelText("Model")) as HTMLInputElement;
    fireEvent.change(model, { target: { value: "gpt-4.1" } });
    // Someone edits config.yaml in a terminal; the page reads it again (as
    // it does when the tab gets focus).
    server.settings = settings({ revision: "rev-2" });
    const before = server.gets;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(server.gets).toBeGreaterThan(before));
    server.patch.mockImplementationOnce(() =>
      json({ error: "revision_mismatch", revision: "rev-2" }, 409)
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.patch).toHaveBeenCalledOnce());
    expect(server.patch.mock.calls[0][0]).toEqual({
      model: "gpt-4.1",
      revision: "rev-1",
    });
    expect(await screen.findByText(/changed elsewhere/)).toBeTruthy();
    // Saving again goes against the revision the conflict reported.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.patch).toHaveBeenCalledTimes(2));
    expect(server.patch.mock.calls[1][0]).toEqual({
      model: "gpt-4.1",
      revision: "rev-2",
    });
  });

  it("drops a key check's result once the key changes or is saved", async () => {
    server.testKey.mockImplementationOnce(() =>
      json({ ok: null, status: "inconclusive", message: "offline" })
    );
    renderView();
    await screen.findByText("Saved: …abcd");
    fireEvent.change(keyInput(), { target: { value: "sk-a-12345678" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Test key" })[0]);
    await screen.findByText(/could not be checked/);
    fireEvent.change(keyInput(), { target: { value: "sk-b-12345678" } });
    expect(screen.queryByText(/could not be checked/)).toBeNull();
  });

  it("clears a key check's result on Discard", async () => {
    renderView();
    await screen.findByText("Saved: …abcd");
    fireEvent.change(keyInput(), { target: { value: "sk-a-12345678" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Test key" })[0]);
    await screen.findByText(/The key works/);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByText(/The key works/)).toBeNull();
  });

  it("explains the backend's own refusal of the local secret", async () => {
    server.patch.mockImplementationOnce(() =>
      json({ error: "local_secret_required" }, 403)
    );
    renderView();
    const model = (await screen.findByLabelText("Model")) as HTMLInputElement;
    fireEvent.change(model, { target: { value: "gpt-4.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(/refused this machine's local secret/)
    ).toBeTruthy();
  });

  it("treats a save answered without a readable body as saved", async () => {
    server.patch.mockImplementationOnce(
      () => new Response("not json", { status: 200 })
    );
    renderView();
    const model = (await screen.findByLabelText("Model")) as HTMLInputElement;
    fireEvent.change(model, { target: { value: "gpt-4.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("offers Restart now again when other fields start to wait", async () => {
    window.evoscientistDesktop = {
      restartBackend: async () => ({ ok: false, code: "not_owned" }),
    };
    server.settings = settings({
      restart_required: true,
      restart_fields: ["model"],
    });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Restart now" }));
    await screen.findByText(
      /did not start this EvoScientist.*EvoSci server stop/
    );
    expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
    server.settings = settings({
      restart_required: true,
      restart_fields: ["model", "tavily_api_key"],
    });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(
      await screen.findByRole("button", { name: "Restart now" })
    ).toBeTruthy();
  });

  it("keeps the edits and names the commands that lock on config_locked", async () => {
    server.patch.mockImplementationOnce(() =>
      json({ error: "config_locked", detail: "locked" }, 409)
    );
    renderView();
    const model = (await screen.findByLabelText("Model")) as HTMLInputElement;
    fireEvent.change(model, { target: { value: "gpt-4.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        /EvoSci onboard, EvoSci configure or EvoSci channel setup/
      )
    ).toBeTruthy();
    expect(model.value).toBe("gpt-4.1");
  });

  it("shows config_unreadable with the file's path", async () => {
    server.patch.mockImplementationOnce(() =>
      json(
        {
          error: "config_unreadable",
          path: "/home/u/.config/evoscientist/config.yaml",
          detail: "line 3, column 1",
        },
        409
      )
    );
    renderView();
    const model = (await screen.findByLabelText("Model")) as HTMLInputElement;
    fireEvent.change(model, { target: { value: "gpt-4.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(/config\.yaml cannot be read.*line 3, column 1/)
    ).toBeTruthy();
  });

  it("greys out a shadowed field and names its source", async () => {
    server.settings = settings({
      sources: { openai_api_key: { source: "env", shadowed: true } },
    });
    renderView();
    await screen.findByText(/Set by an environment variable/);
    expect(keyInput().disabled).toBe(true);
  });

  it("is read-only with the reason when the page cannot save", async () => {
    server.access = { writable: false, reason: "host_not_loopback" };
    renderView();
    expect(await screen.findByText(/read-only here/)).toBeTruthy();
    expect(keyInput().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("shows which changes wait for a restart, and says to stop the server", async () => {
    server.settings = settings({
      restart_required: true,
      restart_fields: ["mcp.yaml", "tavily_api_key"],
    });
    renderView();
    expect(
      await screen.findByText(
        /after EvoScientist restarts: MCP servers \(mcp\.yaml\), Tavily API key\..*EvoSci server stop/
      )
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
  });

  it("restarts through the desktop bridge when there is one", async () => {
    const restartBackend = vi.fn(async () => ({ ok: true as const }));
    window.evoscientistDesktop = { restartBackend };
    server.settings = settings({
      restart_required: true,
      restart_fields: ["model"],
    });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Restart now" }));
    await screen.findByText("EvoScientist is restarting.");
    expect(restartBackend).toHaveBeenCalledOnce();
  });

  it("shows the test-key status, never ok alone", async () => {
    server.testKey.mockImplementationOnce(() =>
      json({ ok: null, status: "inconclusive", message: "Network is off" })
    );
    renderView();
    await screen.findByText("Saved: …abcd");
    fireEvent.change(keyInput(), { target: { value: "sk-new-key-1234" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Test key" })[0]);
    expect(
      await screen.findByText(/could not be checked.*Network is off/)
    ).toBeTruthy();
    expect(server.testKey.mock.calls[0][0]).toEqual({
      provider: "openai",
      key: "sk-new-key-1234",
    });
  });

  it("says when the deployment has no settings API", async () => {
    server.settings = {};
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).startsWith(DEPLOYMENT)
        ? json({ detail: "Not Found" }, 404)
        : json(server.access)
    );
    renderView();
    expect(await screen.findByText(/no settings API/)).toBeTruthy();
  });
  it("does not save a provider without a model for it", async () => {
    renderView();
    await chooseProvider("Ollama");
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Choose or type a model.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  describe("an endpoint whose key is saved", () => {
    const CUSTOM = {
      label: "OpenAI-compatible",
      key_field: "custom_openai_api_key",
      base_url_field: "custom_openai_base_url",
      needs_key: true,
      needs_base_url: true,
      has_check: true,
      lists_models: true,
    };
    const custom = (sources: Record<string, unknown> = {}) =>
      settings({
        providers: { ...PROVIDERS, "custom-openai": CUSTOM },
        sources,
        settings: {
          ...settings().settings,
          provider: "custom-openai",
          model: "my-model",
          custom_openai_api_key: { set: true, hint: "…wxyz" },
          custom_openai_base_url: "http://a.example/v1",
        },
      });
    const baseUrl = () =>
      screen.getByLabelText("OpenAI-compatible base URL") as HTMLInputElement;

    it("asks for the key again with a new address, and sends both", async () => {
      server.settings = custom();
      renderView();
      await screen.findByText("Saved: …wxyz");
      fireEvent.change(baseUrl(), { target: { value: "http://b.example/v1" } });
      expect(screen.getByText(/Enter the API key again/)).toBeTruthy();
      const save = screen.getByRole("button", {
        name: "Save",
      }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("OpenAI-compatible API key"), {
        target: { value: "sk-new-0000" },
      });
      fireEvent.click(save);
      await waitFor(() => expect(server.patch).toHaveBeenCalledOnce());
      expect(server.patch.mock.calls[0][0]).toEqual({
        custom_openai_base_url: "http://b.example/v1",
        custom_openai_api_key: "sk-new-0000",
        revision: "rev-1",
      });
    });

    it("keeps the address when the saved key is also set elsewhere", async () => {
      server.settings = custom({
        custom_openai_api_key: { source: "env", shadowed: true },
      });
      renderView();
      await screen.findByLabelText("OpenAI-compatible base URL");
      expect(baseUrl().disabled).toBe(true);
      expect(screen.getByText(/Its API key is set by/)).toBeTruthy();
    });

    it("tests a new address only with a key typed for it", async () => {
      server.settings = custom();
      renderView();
      await screen.findByText("Saved: …wxyz");
      fireEvent.change(baseUrl(), { target: { value: "http://b.example/v1" } });
      fireEvent.click(screen.getAllByRole("button", { name: "Test key" })[0]);
      expect(
        await screen.findByText(
          "Enter the API key to test it with the new address."
        )
      ).toBeTruthy();
      expect(server.testKey).not.toHaveBeenCalled();
    });

    it("names the field of a refused check", async () => {
      server.settings = custom();
      server.testKey.mockImplementationOnce(() =>
        json({ errors: { base_url: "must be an http or https URL" } }, 400)
      );
      renderView();
      await screen.findByText("Saved: …wxyz");
      fireEvent.click(screen.getAllByRole("button", { name: "Test key" })[0]);
      expect(
        await screen.findByText("Address: must be an http or https URL")
      ).toBeTruthy();
    });
  });
  it("keeps the form when reading the settings again fails", async () => {
    renderView();
    await screen.findByLabelText("Model");
    const fetchMock = vi.mocked(fetch);
    const real = fetchMock.getMockImplementation()!;
    let failed = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `${DEPLOYMENT}/api/settings`) {
        failed += 1;
        throw new TypeError("Failed to fetch");
      }
      return real(input, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(failed).toBeGreaterThan(0));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByText(/could not be read/)).toBeNull();
    expect(screen.getByLabelText("Model")).toBeTruthy();
  });
  it("ignores a key check that answers after the key changed", async () => {
    const answers: Array<(r: Response) => void> = [];
    server.testKey.mockImplementation(
      () => new Promise<Response>((resolve) => answers.push(resolve)) as never
    );
    renderView();
    await screen.findByText("Saved: …abcd");
    const test = () =>
      screen.getAllByRole("button", {
        name: "Test key",
      })[0] as HTMLButtonElement;
    fireEvent.change(keyInput(), { target: { value: "sk-a-12345678" } });
    fireEvent.click(test());
    await waitFor(() => expect(test().disabled).toBe(true));
    fireEvent.change(keyInput(), { target: { value: "sk-b-12345678" } });
    expect(test().disabled).toBe(false);
    fireEvent.click(test());
    await waitFor(() => expect(answers).toHaveLength(2));
    // The first check answers while the second still runs.
    await act(async () =>
      answers[0](json({ ok: true, status: "valid", message: "" }))
    );
    expect(screen.queryByText(/The key works/)).toBeNull();
    expect(test().disabled).toBe(true);
    await act(async () =>
      answers[1](json({ ok: false, status: "invalid", message: "bad key" }))
    );
    expect(screen.queryByText(/The key works/)).toBeNull();
    expect(test().disabled).toBe(false);
  });

  it("takes no input while a save is running", async () => {
    let answer: (r: Response) => void = () => {};
    server.patch.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (answer = resolve)) as never
    );
    renderView();
    const model = (await screen.findByLabelText("Model")) as HTMLInputElement;
    fireEvent.change(model, { target: { value: "gpt-4.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(model.disabled).toBe(true));
    await act(async () =>
      answer(
        json({
          revision: "rev-2",
          changed: ["model"],
          restart_required: false,
          restart_fields: [],
          warnings: {},
        })
      )
    );
    await waitFor(() => expect(model.disabled).toBe(false));
  });

  it("starts from the current revision again once the edits are undone", async () => {
    renderView();
    const model = (await screen.findByLabelText("Model")) as HTMLInputElement;
    fireEvent.change(model, { target: { value: "gpt-4.1" } });
    fireEvent.change(model, { target: { value: "gpt-5" } });
    server.settings = settings({ revision: "rev-9" });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(server.gets).toBeGreaterThan(1));
    await act(async () => {});
    fireEvent.change(model, { target: { value: "gpt-4.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.patch).toHaveBeenCalledOnce());
    expect(server.patch.mock.calls[0][0]).toEqual({
      model: "gpt-4.1",
      revision: "rev-9",
    });
  });
  it("explains a failed restart from the desktop app", async () => {
    window.evoscientistDesktop = {
      restartBackend: () => {
        throw new Error("ipc");
      },
    };
    server.settings = settings({
      restart_required: true,
      restart_fields: ["model"],
    });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Restart now" }));
    expect(
      await screen.findByText("The restart failed (failed).")
    ).toBeTruthy();
  });

  it("shows a save's warning next to its field", async () => {
    server.patch.mockImplementationOnce(() =>
      json({
        revision: "rev-2",
        changed: ["openai_api_key"],
        restart_required: false,
        restart_fields: [],
        warnings: { openai_api_key: "Saved without a check." },
      })
    );
    renderView();
    await screen.findByText("Saved: …abcd");
    fireEvent.change(keyInput(), { target: { value: "sk-new-key-1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved without a check.")).toBeTruthy();
  });
  it("tests a cleared address only after the save", async () => {
    server.settings = settings({
      settings: {
        ...settings().settings,
        provider: "ollama",
        model: "llama3.2",
        ollama_base_url: "http://old.example:11434",
      },
    });
    renderView();
    const address = (await screen.findByLabelText(
      "Ollama base URL"
    )) as HTMLInputElement;
    fireEvent.change(address, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(
      await screen.findByText(/Save first to test the default address/)
    ).toBeTruthy();
    expect(server.testKey).not.toHaveBeenCalled();
  });
});

describe("the Settings page", () => {
  const urlInput = () =>
    screen.getByLabelText("Deployment URL") as HTMLInputElement;

  it("shows both groups on the settings entry", async () => {
    renderSettingsPage();
    expect(
      await screen.findByRole("heading", { name: "General" })
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "This browser" })).toBeTruthy();
    expect(await screen.findByLabelText("OpenAI API key")).toBeTruthy();
    expect(urlInput().value).toBe(DEPLOYMENT);
  });

  it("shows the form, not the wizard, on the settings entry even when setup is needed", async () => {
    server.settings = settings({ setup_needed: true });
    renderSettingsPage();
    await screen.findByRole("button", { name: "Save" });
    expect(screen.queryByRole("region", { name: "Setup wizard" })).toBeNull();
  });

  it("keeps the address editable on a read-only page", async () => {
    server.access = { writable: false, reason: "host_not_loopback" };
    renderSettingsPage();
    expect(
      await screen.findByText(/These settings are read-only here/)
    ).toBeTruthy();
    expect(urlInput().disabled).toBe(false);
  });

  it("still offers Connection when the deployment has no settings API", async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).startsWith(DEPLOYMENT)
        ? json({ detail: "Not Found" }, 404)
        : json(server.access)
    );
    renderSettingsPage();
    expect(await screen.findByText(/no settings API/)).toBeTruthy();
    expect(urlInput().value).toBe(DEPLOYMENT);
  });

  it("points to Connection when the settings cannot be read", async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).startsWith(DEPLOYMENT)
        ? json({ detail: "boom" }, 500)
        : json(server.access)
    );
    renderSettingsPage();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Check the address under Connection",
      })
    );
    expect(document.activeElement).toBe(urlInput());
  });

  it("asks before a new address drops unsaved General edits", async () => {
    const { onSaveUrl } = renderSettingsPage();
    fireEvent.change(await screen.findByLabelText("OpenAI API key"), {
      target: { value: "sk-new" },
    });
    fireEvent.change(urlInput(), {
      target: { value: "http://127.0.0.1:7000" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save deployment URL" })
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Discard and connect" })
    );
    expect(onSaveUrl).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:7000");
  });

  describe("section index", () => {
    const index = () =>
      within(screen.getByRole("navigation", { name: "Settings sections" }));

    // #101's leftovers: a 1024 px window with the sidebar and the inspector
    // docked leaves the page about 460 px, and the index squeezed the form to
    // about 230 px. The page's own width decides, not the window's.
    describe("by the page's own width", () => {
      // A report gives the page's border box (a classic scrollbar inside it
      // included) and its content box (without the scrollbar).
      let report: (border: number, content?: number) => void = () => {};
      // jsdom lays nothing out; every element reads as this wide.
      const page = (border: number, content = border) => {
        vi.spyOn(
          HTMLElement.prototype,
          "getBoundingClientRect"
        ).mockReturnValue({
          width: border,
          height: 0,
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: border,
          bottom: 0,
          toJSON: () => ({}),
        } as DOMRect);
        vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
          content
        );
      };
      beforeEach(() => {
        vi.stubGlobal(
          "ResizeObserver",
          class {
            constructor(callback: ResizeObserverCallback) {
              report = (border, content = border) =>
                act(() =>
                  callback(
                    [
                      {
                        borderBoxSize: [{ inlineSize: border, blockSize: 0 }],
                        contentRect: { width: content },
                      } as unknown as ResizeObserverEntry,
                    ],
                    this as unknown as ResizeObserver
                  )
                );
            }
            observe() {}
            unobserve() {}
            disconnect() {}
          }
        );
        page(0);
      });
      afterEach(() => {
        vi.restoreAllMocks();
      });
      const sectionIndex = () =>
        screen.queryByRole("navigation", { name: "Settings sections" });

      it("leaves the index out where the page is narrow", async () => {
        renderSettingsPage();
        await screen.findByLabelText("OpenAI API key");
        report(500);
        expect(sectionIndex()).toBeNull();
      });

      it("shows the index once the page is wide enough, and not after it narrows", async () => {
        renderSettingsPage();
        await screen.findByLabelText("OpenAI API key");
        report(900);
        expect(sectionIndex()).toBeTruthy();
        report(500);
        expect(sectionIndex()).toBeNull();
      });

      // Read at mount, so it doesn't wait for the observer's first report
      // (useWideEnough's own tests pin that it lands before a paint).
      it("decides at mount, without waiting for the observer", async () => {
        page(500);
        renderSettingsPage();
        await screen.findByLabelText("OpenAI API key");
        expect(sectionIndex()).toBeNull();
      });

      // A classic scrollbar (Windows, a mouse on macOS) comes and goes with
      // the page's height, which the index changes: the form beside it is
      // narrower and taller. Measured without the scrollbar, the index could
      // turn itself on and off every frame near the threshold.
      it("counts a scrollbar's room as page width", async () => {
        page(730, 715);
        renderSettingsPage();
        await screen.findByLabelText("OpenAI API key");
        expect(sectionIndex()).toBeTruthy();
        report(730, 715);
        expect(sectionIndex()).toBeTruthy();
      });
    });

    it("marks the chosen section as current and moves focus to it", async () => {
      renderSettingsPage();
      await screen.findByLabelText("OpenAI API key");
      fireEvent.click(index().getByRole("button", { name: "Connection" }));
      expect(
        index()
          .getByRole("button", { name: "Connection" })
          .getAttribute("aria-current")
      ).toBe("location");
      expect(document.activeElement?.id).toBe("settings-connection");
      expect(index().getByText("General")).toBeTruthy();
      expect(index().queryByText("EvoScientist")).toBeNull();
    });

    // Named like the rest of the app (the inspector's Workspace tab); the
    // mirrors are about downloads, not the workspace, so they have their own.
    it("lists the General sections as Model, Search, Workspace and Mirrors", async () => {
      renderSettingsPage();
      await screen.findByLabelText("OpenAI API key");
      const names = index()
        .getAllByRole("button")
        .map((b) => b.textContent);
      expect(names).toEqual([
        "Model",
        "Search",
        "Workspace",
        "Mirrors",
        "Connection",
        "Display",
      ]);
      expect(
        within(screen.getByRole("group", { name: "Workspace" })).getByLabelText(
          "Default folder"
        )
      ).toBeTruthy();
      expect(
        within(screen.getByRole("group", { name: "Mirrors" })).getByLabelText(
          /Use mainland China mirrors/
        )
      ).toBeTruthy();
      expect(
        within(screen.getByRole("group", { name: "Search" })).getByLabelText(
          "Tavily API key"
        )
      ).toBeTruthy();
    });

    it("offers only the sections that are on the page", async () => {
      vi.mocked(fetch).mockImplementation(async (input) =>
        String(input).startsWith(DEPLOYMENT)
          ? json({ detail: "Not Found" }, 404)
          : json(server.access)
      );
      renderSettingsPage();
      await screen.findByText(/no settings API/);
      for (const name of ["Model", "Search", "Workspace", "Mirrors"]) {
        expect(
          (index().getByRole("button", { name }) as HTMLButtonElement).disabled
        ).toBe(true);
      }
      expect(
        (
          index().getByRole("button", {
            name: "Connection",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false);
    });

    // A click pins its entry while the smooth scroll runs; the user scrolling
    // on their own ends the pin, or the index would keep the clicked entry.
    it("lets the user's own scrolling take over from a clicked entry", async () => {
      let report: ((entries: unknown[]) => void) | null = null;
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          constructor(cb: (entries: unknown[]) => void) {
            report = cb;
          }
          observe() {}
          disconnect() {}
        }
      );
      renderSettingsPage();
      await screen.findByLabelText("OpenAI API key");
      await waitFor(() => expect(report).not.toBeNull());
      fireEvent.click(index().getByRole("button", { name: "Connection" }));
      const scroller = screen
        .getByRole("navigation", { name: "Settings sections" })
        .closest(".overflow-y-auto")!;
      fireEvent.wheel(scroller);
      const web = document.getElementById("settings-search")!;
      act(() => report!([{ target: web, isIntersecting: true }]));
      expect(
        index()
          .getByRole("button", { name: "Search" })
          .getAttribute("aria-current")
      ).toBe("location");
    });

    it("follows the section in view while the page scrolls", async () => {
      let report: ((entries: unknown[]) => void) | null = null;
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          constructor(cb: (entries: unknown[]) => void) {
            report = cb;
          }
          observe() {}
          disconnect() {}
        }
      );
      renderSettingsPage();
      await screen.findByLabelText("OpenAI API key");
      await waitFor(() => expect(report).not.toBeNull());
      const web = document.getElementById("settings-search")!;
      act(() => report!([{ target: web, isIntersecting: true }]));
      expect(
        index()
          .getByRole("button", { name: "Search" })
          .getAttribute("aria-current")
      ).toBe("location");
      expect(
        index()
          .getByRole("button", { name: "Model" })
          .getAttribute("aria-current")
      ).toBeNull();
    });
  });

  // The gear closes only `view=settings`; a `setup` entry showing the form
  // hands over to it, so the first click on the pressed gear closes the page.
  it("hands the setup entry over to Settings once it shows the form", async () => {
    const { onFormShown } = renderView();
    await screen.findByRole("button", { name: "Save" });
    await waitFor(() => expect(onFormShown).toHaveBeenCalled());
  });

  // The desktop app opens `?view=setup` while EvoSci may still be starting:
  // a first read that fails must not hand the first run over to the form.
  it("keeps the setup entry through a failed first read, then shows the wizard", async () => {
    server.settings = settings({ setup_needed: true });
    const fetchMock = vi.mocked(fetch);
    const real = fetchMock.getMockImplementation()!;
    let failing = true;
    fetchMock.mockImplementation(async (input, init) => {
      if (failing && String(input) === `${DEPLOYMENT}/api/settings`) {
        throw new TypeError("Failed to fetch");
      }
      return real(input, init);
    });
    const { onFormShown } = renderView();
    await screen.findByText(/could not be read/);
    await act(async () => {});
    expect(onFormShown).not.toHaveBeenCalled();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await screen.findByRole("region", { name: "Setup wizard" });
    expect(onFormShown).not.toHaveBeenCalled();
  });

  it("keeps the setup entry while the wizard shows", async () => {
    server.settings = settings({ setup_needed: true });
    const { onFormShown } = renderView();
    await screen.findByRole("region", { name: "Setup wizard" });
    await act(async () => {});
    expect(onFormShown).not.toHaveBeenCalled();
  });

  it("cannot switch the address while the General save runs", async () => {
    server.patch.mockImplementationOnce(
      () => new Promise<Response>(() => {}) as unknown as Response
    );
    renderSettingsPage();
    fireEvent.change(await screen.findByLabelText("OpenAI API key"), {
      target: { value: "sk-new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Save deployment URL",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true)
    );
  });
});

describe("the setup wizard", () => {
  beforeEach(() => {
    server.settings = settings({
      setup_needed: true,
      settings: {
        ...settings().settings,
        openai_api_key: { set: false },
      },
    });
  });

  const next = () =>
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

  it("walks provider, model, key, Tavily, folder, summary and saves once", async () => {
    renderView();
    const wizard = await screen.findByRole("region", { name: "Setup wizard" });
    expect(within(wizard).getByText("Choose a provider")).toBeTruthy();
    next();
    expect(within(wizard).getByText("Choose a model")).toBeTruthy();
    next();
    expect(within(wizard).getByText("Connect to it")).toBeTruthy();
    // The key is required before going on.
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.change(keyInput(), { target: { value: "sk-new-key-1234" } });
    next();
    expect(within(wizard).getByText("Search (optional)")).toBeTruthy();
    expect(
      within(wizard).getByText(/You can add one later in Settings\./)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(within(wizard).getByText("Workspace and mirrors")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Use mainland China mirrors/));
    next();
    expect(within(wizard).getByText("Check and finish")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(server.patch).toHaveBeenCalledOnce());
    expect(server.patch.mock.calls[0][0]).toEqual({
      openai_api_key: "sk-new-key-1234",
      mirror: "cn",
      revision: "rev-1",
    });
  });

  it("does not send a key typed for a provider the user switched away from", async () => {
    renderView();
    await screen.findByRole("region", { name: "Setup wizard" });
    next();
    next();
    fireEvent.change(keyInput(), { target: { value: "sk-wrong-0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await chooseProvider("Ollama");
    next();
    next();
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "llama3.2" },
    });
    next();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    next();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(server.patch).toHaveBeenCalledOnce());
    expect(server.patch.mock.calls[0][0]).toEqual({
      provider: "ollama",
      model: "llama3.2",
      revision: "rev-1",
    });
  });

  it("shows a save error for a field no step holds, on the summary", async () => {
    server.patch.mockImplementationOnce(() =>
      json({ errors: { show_thinking: "expected true or false" } }, 400)
    );
    renderView();
    await screen.findByRole("region", { name: "Setup wizard" });
    next();
    next();
    fireEvent.change(keyInput(), { target: { value: "sk-new-key-1234" } });
    next();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    next();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(
      await screen.findByText("Show thinking: expected true or false")
    ).toBeTruthy();
    expect(screen.getByText("Check and finish")).toBeTruthy();
  });

  it("asks Ollama for its address first and offers the models it lists", async () => {
    server.testKey.mockImplementationOnce(() =>
      json({
        ok: true,
        status: "valid",
        message: "",
        models: ["llama3.2", "qwen3"],
      })
    );
    renderView();
    await chooseProvider("Ollama");
    next();
    expect(screen.getByText("Connect to it")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Ollama base URL"), {
      target: { value: "http://127.0.0.1:11434" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("The server answers.")).toBeTruthy();
    expect(server.testKey.mock.calls[0][0]).toEqual({
      provider: "ollama",
      base_url: "http://127.0.0.1:11434",
    });
    next();
    expect(screen.getByText("Choose a model")).toBeTruthy();
    // The list shows every suggestion, whatever the field holds.
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "claude-sonnet-5-5" },
    });
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Choose from the model list" }),
      { key: "Enter" }
    );
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["llama3.2", "qwen3"]);
    fireEvent.click(items[1]);
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(
      "qwen3"
    );
    // A name the server did not list can be typed.
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "my-model:latest" },
    });
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it("goes back to the chat on Configure later", async () => {
    const { onClose } = renderView();
    fireEvent.click(
      await screen.findByRole("button", { name: "Configure later" })
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the form, not the wizard, once Setup was put off", async () => {
    deferSetup(DEPLOYMENT);
    renderView();
    await screen.findByRole("button", { name: "Save" });
    expect(screen.queryByRole("region", { name: "Setup wizard" })).toBeNull();
  });

  it("fills in the desktop app's default folder", async () => {
    window.evoscientistDesktop = { defaultFolder: "/home/u/Documents/Evo" };
    renderView();
    await screen.findByRole("region", { name: "Setup wizard" });
    next();
    next();
    fireEvent.change(keyInput(), { target: { value: "sk-new-key-1234" } });
    next();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(
      (screen.getByLabelText("Default folder") as HTMLInputElement).value
    ).toBe("/home/u/Documents/Evo");
  });
  it("offers the chosen provider's model, and asks for one where the check lists them", async () => {
    server.settings = settings({
      setup_needed: true,
      providers: {
        ...PROVIDERS,
        anthropic: {
          ...PROVIDERS.openai,
          label: "Anthropic",
          key_field: "anthropic_api_key",
        },
      },
    });
    renderView();
    await chooseProvider("Anthropic");
    next();
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(
      "claude-x"
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await chooseProvider("Ollama");
    next();
    next();
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("");
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
  it("does not go on with a provider EvoScientist does not know", async () => {
    server.settings = settings({
      setup_needed: true,
      settings: { ...settings().settings, provider: "gone-provider" },
    });
    renderView();
    await screen.findByRole("region", { name: "Setup wizard" });
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("offers the desktop app's folder once", async () => {
    window.evoscientistDesktop = { defaultFolder: "/home/u/Documents/Evo" };
    renderView();
    await screen.findByRole("region", { name: "Setup wizard" });
    next();
    next();
    fireEvent.change(keyInput(), { target: { value: "sk-new-key-1234" } });
    next();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    const folder = () =>
      screen.getByLabelText("Default folder") as HTMLInputElement;
    fireEvent.change(folder(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(folder().value).toBe("");
  });

  it("does not offer the desktop app's folder for a saved folder the user emptied", async () => {
    window.evoscientistDesktop = { defaultFolder: "/home/u/Documents/Evo" };
    server.settings = settings({
      setup_needed: true,
      settings: { ...settings().settings, default_workdir: "/srv/work" },
    });
    renderView();
    await screen.findByRole("region", { name: "Setup wizard" });
    next();
    next();
    fireEvent.change(keyInput(), { target: { value: "sk-new-key-1234" } });
    next();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    const folder = () =>
      screen.getByLabelText("Default folder") as HTMLInputElement;
    expect(folder().value).toBe("/srv/work");
    fireEvent.change(folder(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(folder().value).toBe("");
  });

  it("does not fill in a folder set by a flag of the running EvoSci", async () => {
    window.evoscientistDesktop = { defaultFolder: "/home/u/Documents/Evo" };
    server.settings = settings({
      setup_needed: true,
      sources: { default_workdir: { source: "cli", shadowed: true } },
      settings: { ...settings().settings, openai_api_key: { set: false } },
    });
    renderView();
    await screen.findByRole("region", { name: "Setup wizard" });
    next();
    next();
    fireEvent.change(keyInput(), { target: { value: "sk-new-key-1234" } });
    next();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(
      (screen.getByLabelText("Default folder") as HTMLInputElement).value
    ).toBe("");
  });

  it("lists the server's models on the model step without a test first", async () => {
    server.testKey.mockImplementationOnce(() =>
      json({ ok: true, status: "valid", message: "", models: ["llama3.2"] })
    );
    renderView();
    await chooseProvider("Ollama");
    next();
    fireEvent.change(screen.getByLabelText("Ollama base URL"), {
      target: { value: "http://127.0.0.1:11434" },
    });
    next();
    await waitFor(() => expect(server.testKey).toHaveBeenCalledOnce());
    expect(server.testKey.mock.calls[0][0]).toEqual({
      provider: "ollama",
      base_url: "http://127.0.0.1:11434",
    });
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Choose from the model list" }),
      { key: "Enter" }
    );
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["llama3.2"]);
  });

  it("says on the summary that a key is set by the environment", async () => {
    server.settings = settings({
      setup_needed: true,
      sources: { openai_api_key: { source: "env", shadowed: true } },
      settings: { ...settings().settings, openai_api_key: { set: false } },
    });
    renderView();
    await screen.findByRole("region", { name: "Setup wizard" });
    next();
    next();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    next();
    expect(screen.getByText("Check and finish")).toBeTruthy();
    expect(screen.getByText("set by an environment variable")).toBeTruthy();
  });

  it("shows the form, not the wizard, when the page cannot save", async () => {
    server.access = { writable: false, reason: "not_loopback" };
    renderView();
    await screen.findByLabelText("Provider");
    expect(screen.queryByRole("region", { name: "Setup wizard" })).toBeNull();
  });

  it("asks a custom endpoint for its address and key first, then offers its models", async () => {
    server.settings = settings({
      setup_needed: true,
      providers: {
        ...PROVIDERS,
        "custom-openai": {
          label: "OpenAI-compatible",
          key_field: "custom_openai_api_key",
          base_url_field: "custom_openai_base_url",
          needs_key: true,
          needs_base_url: true,
          has_check: true,
          lists_models: true,
        },
      },
    });
    server.testKey.mockImplementationOnce(() =>
      json({ ok: true, status: "valid", message: "", models: ["m1", "m2"] })
    );
    renderView();
    await chooseProvider("OpenAI-compatible");
    next();
    const nextButton = () =>
      screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(screen.getByText("Connect to it")).toBeTruthy();
    expect(nextButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("OpenAI-compatible base URL"), {
      target: { value: "http://h.example/v1" },
    });
    expect(nextButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("OpenAI-compatible API key"), {
      target: { value: "sk-custom-1234" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Test key" })[0]);
    await screen.findByText(/The key works/);
    expect(server.testKey.mock.calls[0][0]).toEqual({
      provider: "custom-openai",
      key: "sk-custom-1234",
      base_url: "http://h.example/v1",
    });
    next();
    expect(screen.getByText("Choose a model")).toBeTruthy();
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Choose from the model list" }),
      { key: "Enter" }
    );
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["m1", "m2"]);
  });
});

describe("the chat notice", () => {
  const renderNotice = () => {
    const onOpenSetup = vi.fn();
    render(<SetupNotice onOpenSetup={onOpenSetup} />, { wrapper });
    return onOpenSetup;
  };

  it("links to Settings when setup is needed and the page can save", async () => {
    server.settings = settings({ setup_needed: true });
    const onOpenSetup = renderNotice();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Settings" })
    );
    expect(onOpenSetup).toHaveBeenCalledOnce();
  });

  it("says to configure the machine that runs EvoScientist when read-only", async () => {
    server.settings = settings({ setup_needed: true });
    server.access = { writable: false, reason: "host_not_loopback" };
    renderNotice();
    expect(
      await screen.findByText(/Configure it on the machine that runs it/)
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });

  it("shows config_error with its path", async () => {
    server.settings = settings({
      setup_needed: false,
      config_error: {
        error: "config_unreadable",
        path: "/c/config.yaml",
        detail: "line 2, column 5",
      },
    });
    renderNotice();
    expect(
      await screen.findByText(/\/c\/config\.yaml.*line 2, column 5/)
    ).toBeTruthy();
  });

  it("stays away when EvoScientist is set up", async () => {
    renderNotice();
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("the first-run gate", () => {
  function renderGate(view: string | null = null) {
    const setView = vi.fn();
    const hook = renderHook(({ v }) => useSetupGate(v, setView), {
      wrapper,
      initialProps: { v: view },
    });
    return { setView, hook };
  }

  it("opens the wizard when setup is needed and the page can save", async () => {
    server.settings = settings({ setup_needed: true });
    const { setView } = renderGate();
    await waitFor(() => expect(setView).toHaveBeenCalledWith("setup"));
  });

  it.each([
    ["set up already", () => settings()],
    [
      "with a config error",
      () =>
        settings({
          setup_needed: true,
          config_error: { error: "config_unreadable", path: "/c", detail: "" },
        }),
    ],
  ])("stays closed when %s", async (_, make) => {
    server.settings = make();
    const { setView } = renderGate();
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    expect(setView).not.toHaveBeenCalled();
  });

  it("stays closed when the settings are read-only", async () => {
    server.settings = settings({ setup_needed: true });
    server.access = { writable: false, reason: "not_loopback" };
    const { setView } = renderGate();
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    expect(setView).not.toHaveBeenCalled();
  });

  it("stays closed for a remote deployment", async () => {
    server.settings = settings({ setup_needed: true, instance: "ffffffff" });
    const { setView } = renderGate();
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    expect(setView).not.toHaveBeenCalled();
  });

  it("counts leaving Setup as Configure later", async () => {
    server.settings = settings({ setup_needed: true });
    const { setView, hook } = renderGate("setup");
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    hook.rerender({ v: null });
    await act(async () => {});
    expect(setView).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        window.sessionStorage.getItem("evoscientist-setup-later")
      ).toContain(DEPLOYMENT)
    );
  });
  it("counts leaving Settings as Configure later", async () => {
    server.settings = settings({ setup_needed: true });
    const { setView, hook } = renderGate("settings");
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    hook.rerender({ v: null });
    await act(async () => {});
    expect(setView).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        window.sessionStorage.getItem("evoscientist-setup-later")
      ).toContain(DEPLOYMENT)
    );
  });

  // Configure later is about setup that is needed: a record made while it is
  // not would later keep the wizard closed in this tab.
  it("does not count leaving Settings when setup is not needed", async () => {
    const { hook } = renderGate("settings");
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    hook.rerender({ v: null });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(
      window.sessionStorage.getItem("evoscientist-setup-later")
    ).toBeNull();
  });

  // Right after setView("setup") a render can still report the old view
  // (seen on a cold first run); that flicker is not the user leaving, and
  // counting it turned a first run's wizard into the form.
  it("does not count a one-render flicker out of Setup as Configure later", async () => {
    server.settings = settings({ setup_needed: true });
    const { hook } = renderGate("setup");
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    hook.rerender({ v: null });
    hook.rerender({ v: "setup" });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(
      window.sessionStorage.getItem("evoscientist-setup-later")
    ).toBeNull();
  });

  // Each return to Setup drops the flicker before it, so the next one does
  // not find it waiting and keep it.
  it("does not count two flickers in a row as Configure later", async () => {
    server.settings = settings({ setup_needed: true });
    const { hook } = renderGate("setup");
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    hook.rerender({ v: null });
    hook.rerender({ v: "setup" });
    hook.rerender({ v: null });
    hook.rerender({ v: "setup" });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(
      window.sessionStorage.getItem("evoscientist-setup-later")
    ).toBeNull();
  });

  // A leave whose check has not run yet survives the page going away or the
  // gate unmounting, once the address bar has left Setup.
  it("keeps a pending leave on pagehide once the address bar has left Setup", async () => {
    server.settings = settings({ setup_needed: true });
    const { hook } = renderGate("setup");
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    hook.rerender({ v: null });
    window.dispatchEvent(new Event("pagehide"));
    expect(window.sessionStorage.getItem("evoscientist-setup-later")).toContain(
      DEPLOYMENT
    );
  });

  it("keeps a pending leave on unmount once the address bar has left Setup", async () => {
    server.settings = settings({ setup_needed: true });
    const { hook } = renderGate("setup");
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    hook.rerender({ v: null });
    hook.unmount();
    expect(window.sessionStorage.getItem("evoscientist-setup-later")).toContain(
      DEPLOYMENT
    );
  });

  // As in the traced cold first run: nuqs has written view=setup to the
  // address bar while a render still reports the old view.
  it("waits for the address bar to leave Setup before counting a leave", async () => {
    server.settings = settings({ setup_needed: true });
    window.history.replaceState(null, "", "/?view=setup");
    const { hook } = renderGate("setup");
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    hook.rerender({ v: null });
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(
      window.sessionStorage.getItem("evoscientist-setup-later")
    ).toBeNull();
    window.history.replaceState(null, "", "/");
    await waitFor(() =>
      expect(
        window.sessionStorage.getItem("evoscientist-setup-later")
      ).toContain(DEPLOYMENT)
    );
  });

  it("does not count a stale render when the page goes away with the address bar on Setup", async () => {
    server.settings = settings({ setup_needed: true });
    window.history.replaceState(null, "", "/?view=setup");
    const { hook } = renderGate("setup");
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    hook.rerender({ v: null });
    window.dispatchEvent(new Event("pagehide"));
    expect(
      window.sessionStorage.getItem("evoscientist-setup-later")
    ).toBeNull();
  });

  // The gear opens Settings before the gate decides; the user has seen the
  // fields there, so the chat they return to is not taken away by the wizard.
  it("does not open the wizard over a page that started on Settings", async () => {
    server.settings = settings({ setup_needed: true });
    const { setView, hook } = renderGate("settings");
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    resetSetupDeferral();
    hook.rerender({ v: null });
    await act(async () => {});
    expect(setView).not.toHaveBeenCalled();
  });

  it("does not take the chat away when setup is needed later", async () => {
    const setView = vi.fn();
    const { result } = renderHook(
      () => {
        useSetupGate(null, setView);
        return useSettings();
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current.payload).toBeDefined());
    await act(async () => {});
    server.settings = settings({ setup_needed: true });
    await act(() => result.current.refresh());
    await act(async () => {});
    expect(setView).not.toHaveBeenCalled();
  });
  it("does not open again after Configure later, also after a reload", async () => {
    deferSetup(DEPLOYMENT);
    // A reload starts with nothing in memory and keeps the tab's
    // sessionStorage.
    const kept = window.sessionStorage.getItem("evoscientist-setup-later");
    resetSetupDeferral();
    window.sessionStorage.setItem("evoscientist-setup-later", kept ?? "");
    server.settings = settings({ setup_needed: true });
    const { setView } = renderGate();
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    expect(setView).not.toHaveBeenCalled();
  });

  it("waits for the chat when another view is open", async () => {
    server.settings = settings({ setup_needed: true });
    const { setView, hook } = renderGate("memory");
    await waitFor(() => expect(server.gets).toBeGreaterThan(0));
    await act(async () => {});
    expect(setView).not.toHaveBeenCalled();
    hook.rerender({ v: null });
    await waitFor(() => expect(setView).toHaveBeenCalledWith("setup"));
  });
});
