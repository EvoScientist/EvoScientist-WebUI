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

function renderView(onClose = vi.fn()) {
  render(<SetupView onClose={onClose} />, { wrapper });
  return { onClose };
}

const keyInput = () =>
  screen.getByLabelText("OpenAI API key") as HTMLInputElement;

describe("the Setup form", () => {
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
    await screen.findByText(/did not start this EvoScientist/);
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

  it("shows which changes wait for a restart, and says to restart EvoSci", async () => {
    server.settings = settings({
      restart_required: true,
      restart_fields: ["mcp.yaml", "tavily_api_key"],
    });
    renderView();
    expect(
      await screen.findByText(
        /after EvoScientist restarts: MCP servers \(mcp\.yaml\), Tavily API key\. Restart EvoSci/
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
    const provider = (await screen.findByLabelText(
      "Provider"
    )) as HTMLSelectElement;
    fireEvent.change(provider, { target: { value: "ollama" } });
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
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
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
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "ollama" },
    });
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
    const provider = (await screen.findByLabelText(
      "Provider"
    )) as HTMLSelectElement;
    fireEvent.change(provider, { target: { value: "ollama" } });
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
    const provider = (await screen.findByLabelText(
      "Provider"
    )) as HTMLSelectElement;
    fireEvent.change(provider, { target: { value: "anthropic" } });
    next();
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(
      "claude-x"
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "ollama" },
    });
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
    fireEvent.change(await screen.findByLabelText("Provider"), {
      target: { value: "ollama" },
    });
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
    fireEvent.change(await screen.findByLabelText("Provider"), {
      target: { value: "custom-openai" },
    });
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

  it("links to Setup when setup is needed and the page can save", async () => {
    server.settings = settings({ setup_needed: true });
    const onOpenSetup = renderNotice();
    fireEvent.click(await screen.findByRole("button", { name: "Open Setup" }));
    expect(onOpenSetup).toHaveBeenCalledOnce();
  });

  it("says to configure the machine that runs EvoScientist when read-only", async () => {
    server.settings = settings({ setup_needed: true });
    server.access = { writable: false, reason: "host_not_loopback" };
    renderNotice();
    expect(
      await screen.findByText(/Configure it on the machine that runs it/)
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Setup" })).toBeNull();
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
    expect(window.sessionStorage.getItem("evoscientist-setup-later")).toContain(
      DEPLOYMENT
    );
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
