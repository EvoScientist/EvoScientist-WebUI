// @vitest-environment jsdom
//
// /goal in the composer: a goal request instead of a message, the core's
// refusals, show opening the goal pill, the queue, a backend without goals,
// and the reports of finished background work as followup turns.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { toast } from "sonner";
import type { Message } from "@langchain/langgraph-sdk";
import {
  MockStreamStore,
  clearMockStreamStore,
  installMockStreamStore,
  useMockStreamHook,
} from "@/test/mockUseStream";
import {
  MockClient,
  clearMockClient,
  getActiveMockClient,
  installMockClient,
} from "@/test/mockClient";

vi.mock("@langchain/langgraph-sdk/react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useStream: useMockStreamHook };
});

vi.mock("@/providers/ClientProvider", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ClientProvider: ({ children }: { children: React.ReactNode }) => children,
    useClient: () => getActiveMockClient(),
    useDeployment: () => ({ deploymentUrl: null, apiKey: "" }),
  };
});

// The thread the (mocked) URL state opens on; null = a new chat.
const route = vi.hoisted(() => ({ threadId: null as string | null }));
vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: () => react.useState<string | null>(route.threadId),
  };
});

// The "Not sent" toast's Copy action.
const clipboard = vi.hoisted(() => ({ copied: [] as string[], works: true }));
vi.mock("@/lib/clipboard", () => ({
  copyText: async (text: string) => {
    if (!clipboard.works) return false;
    clipboard.copied.push(text);
    return true;
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// Finished background work and the thread's auto-report switch.
const agents = vi.hoisted(() => ({
  tasks: [] as unknown[],
  autoNotify: false,
}));
vi.mock("@/app/hooks/useAsyncAgents", () => ({
  useAsyncAgents: () => ({
    tasks: agents.tasks,
    loaded: true,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("@/app/hooks/useAutoNotify", () => ({
  useAutoNotify: () => [agents.autoNotify, () => {}],
}));
vi.mock("@/app/hooks/useAvailableModels", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { useAvailableModels: m.useAvailableModelsMock };
});
vi.mock("use-stick-to-bottom", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { useStickToBottom: m.useStickToBottomMock };
});
vi.mock("@/lib/uiSettings", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { useCollapseAgentActions: m.useCollapseAgentActionsMock };
});

vi.mock("@/app/components/ChatMessage", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { ChatMessage: m.stubComponent("ChatMessage") };
});
vi.mock("@/app/components/ActionGroup", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { ActionGroup: m.stubComponent("ActionGroup") };
});
vi.mock("@/app/components/AskUserInterrupt", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { AskUserInterrupt: m.stubComponent("AskUserInterrupt") };
});
vi.mock("@/app/components/CompactionSummary", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { CompactionSummary: m.stubComponent("CompactionSummary") };
});
vi.mock("@/app/components/ResearchDashboard", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { ResearchDashboard: m.stubComponent("ResearchDashboard") };
});
vi.mock("@/app/components/TasksFilesSidebar", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { FilesPopover: m.stubComponent("FilesPopover") };
});
vi.mock("@/app/components/GoalPill", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { GoalPill: m.stubComponent("GoalPill") };
});

import { renderChatInterface } from "@/test/renderChatInterface";
import { mockWorkspace } from "@/test/mockWorkspace";
import {
  getLastProps,
  resetComponentSpy,
} from "@/test/mocks/chatInterfaceStubs";
import type { MainChatReporter } from "@/lib/asyncAgents";

const WITH_GOAL = {
  input_schema: { properties: { messages: {}, goal_request: {} } },
};
const goalValues = (status: string) => ({
  messages: [
    { id: "h1", type: "human", content: "earlier" },
  ] as unknown as Message[],
  _goal: {
    objective: "Write hello",
    status,
    note: null,
    evidence: null,
    rubric_id: "goal:abc",
    start: "h1",
  },
  _sticky_rubric: { text: "- one", id: "goal:abc" },
});
const FINISHED = {
  task_id: "task-1",
  agent_name: "writing-agent",
  run_id: "run-1",
  status: "success",
  liveStatus: "success",
};

type Submitted = {
  values: {
    messages?: Message[];
    goal_request?: Record<string, unknown> | null;
  } | null;
  options: { config?: { configurable?: Record<string, unknown> } };
};

describe("/goal in the composer", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    // Auto-report keeps its per-thread baseline in localStorage.
    window.localStorage.clear();
    route.threadId = null;
    agents.tasks = [];
    agents.autoNotify = false;
    clipboard.copied.length = 0;
    clipboard.works = true;
    vi.mocked(toast.info).mockImplementation(() => "toast-id");
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
    resetComponentSpy();
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
    vi.clearAllMocks();
  });

  const submits = () => stream.getSubmitCalls() as unknown as Submitted[];
  // The "Not sent" notice's options, and its description rendered.
  const notSentToast = () =>
    vi
      .mocked(toast.info)
      .mock.calls.find(([title]) =>
        String(title).startsWith("Not sent: ")
      )?.[1] as unknown as { description?: React.ReactNode; duration?: number };
  const showNotSent = () => render(<>{notSentToast().description}</>);
  // What the "Not sent" toasts name (their first lines).
  const notSent = () =>
    vi
      .mocked(toast.info)
      .mock.calls.map(([title]) => String(title))
      .filter((title) => title.startsWith("Not sent: "))
      .map((title) => title.slice("Not sent: ".length));

  async function mount(
    opts: Parameters<typeof renderChatInterface>[0] = {},
    {
      goals = true,
      threadValues,
    }: { goals?: boolean; threadValues?: Record<string, unknown> } = {}
  ) {
    const client = getActiveMockClient();
    if (goals) client.assistants.getSchemas.mockResolvedValue(WITH_GOAL);
    if (threadValues) {
      route.threadId = "t-1";
      client.setThreadState("t-1", {
        next: [],
        tasks: [],
        values: threadValues,
      });
    }
    const view = renderChatInterface(opts);
    await waitFor(() =>
      expect(client.assistants.getSchemas).toHaveBeenCalled()
    );
    await act(async () => {});
    if (threadValues?._goal) {
      await waitFor(() =>
        expect(getLastProps<{ goal: unknown }>("GoalPill")?.goal).toBeTruthy()
      );
    }
    const textarea = view.container.querySelector("textarea")!;
    const type = (text: string) => {
      fireEvent.change(textarea, { target: { value: text } });
      fireEvent.keyDown(textarea, { key: "Enter" });
    };
    return { ...view, textarea, type };
  }

  // The `/` menu offers the Goal page, then the Model page, above the
  // skills (chatInterface.test has the menu without goals).
  it("lists the Goal and Model pages above the skills in the / menu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            String(url).includes("/api/skills/pinnable")
              ? JSON.stringify({
                  skills: [
                    {
                      name: "paper-writing",
                      description: "Write a paper",
                      source: "global",
                    },
                  ],
                })
              : "{}"
          )
      )
    );
    try {
      const { textarea } = await mount();
      act(() => textarea.focus());
      fireEvent.change(textarea, { target: { value: "/" } });
      await waitFor(() =>
        expect(screen.getAllByRole("option")).toHaveLength(3)
      );
      const rows = screen
        .getAllByRole("option")
        .map((o) => o.textContent ?? "");
      expect(rows[0]).toContain("Goal");
      expect(rows[0]).toContain("Set a goal to keep working toward");
      expect(rows[1]).toContain("Model");
      expect(rows[2]).toContain("/paper-writing");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Independent review, checkpoint A: while goal support is unknown, "goal"
  // stays a command word, as it always was (only a backend known not to run
  // goals frees it for skills).
  it("keeps /goal a command while goal support is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              skills: [
                {
                  name: "research-ideation",
                  description: "Rank goal ideas",
                  source: "global",
                },
              ],
            })
          )
      )
    );
    getActiveMockClient().assistants.getSchemas.mockImplementation(
      () => new Promise(() => {})
    );
    try {
      const { textarea } = await mount({}, { goals: false });
      act(() => textarea.focus());
      fireEvent.change(textarea, { target: { value: "/goal" } });
      await act(async () => {});
      expect(screen.queryByRole("listbox")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // A typed /goal stays text (only the Goal page puts the box in goal mode),
  // and goes out as a goal request as before.
  it("shows no chip for a typed /goal", async () => {
    const { container, textarea } = await mount();
    act(() => textarea.focus());
    fireEvent.change(textarea, { target: { value: "/goal write x" } });
    expect(container.querySelector('[data-slot="composer-chip"]')).toBeNull();
    expect(textarea.value).toBe("/goal write x");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(submits()[0].values).toMatchObject({
      goal_request: { kind: "create", objective: "write x" },
    });
  });

  // Agent #1 (checkpoint B): after a skill chip the box's first word is the
  // command. /model and /goal show answer and the chip stays; a goal request
  // goes without the skill (said, as Set a goal… says it).
  it("runs /model and /goal typed after a skill chip as commands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              skills: [
                {
                  name: "paper-review",
                  description: "Review a paper",
                  source: "global",
                },
              ],
            })
          )
      )
    );
    try {
      const { container, textarea } = await mount(
        {},
        { threadValues: goalValues("active") }
      );
      const chip = () =>
        container
          .querySelector("form")!
          .querySelector('[data-slot="composer-chip"]')?.textContent;
      const enter = (text: string) => {
        fireEvent.change(textarea, { target: { value: text } });
        fireEvent.keyDown(textarea, { key: "Enter" });
      };
      act(() => textarea.focus());
      fireEvent.change(textarea, { target: { value: "/paper-review hi" } });
      await waitFor(() => expect(chip()).toBe("paper-review"));
      enter("/model");
      expect(screen.getByRole("listbox", { name: "Model" })).toBeTruthy();
      expect(chip()).toBe("paper-review");
      expect(textarea.value).toBe("");
      fireEvent.keyDown(textarea, { key: "Escape" });
      // Set as the model (this harness can't store it on the thread), not
      // sent as a message; the chip stays.
      enter("/model gpt-5.5");
      await act(async () => {});
      expect(submits()).toHaveLength(0);
      expect(textarea.value).toBe("");
      expect(chip()).toBe("paper-review");
      enter("/goal");
      expect(getLastProps<{ open: boolean }>("GoalPill")?.open).toBe(true);
      expect(chip()).toBe("paper-review");
      expect(submits()).toHaveLength(0);
      enter("/goal pause");
      expect(submits()).toHaveLength(1);
      expect(submits()[0].values).toMatchObject({
        messages: [],
        goal_request: { kind: "pause" },
      });
      expect(toast.info).toHaveBeenCalledWith(
        "A goal doesn't take skills, so /paper-review came off."
      );
      expect(chip()).toBeUndefined();
      expect(textarea.value).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Codex, confirm round B: the command after a leading /word runs whatever
  // the skill names say, so a paste sent before they arrive reads alike.
  it("runs a command after a /word before the skill names arrive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        String(url).includes("/api/skills/pinnable")
          ? new Promise<Response>(() => {})
          : Promise.resolve(new Response("{}"))
      )
    );
    try {
      const { textarea } = await mount(
        {},
        { threadValues: goalValues("active") }
      );
      act(() => textarea.focus());
      fireEvent.change(textarea, {
        target: { value: "/paper-review /goal pause" },
      });
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(submits()).toHaveLength(1);
      expect(submits()[0].values).toMatchObject({
        messages: [],
        goal_request: { kind: "pause" },
      });
      expect(toast.info).toHaveBeenCalledWith(
        "A goal doesn't take skills, so /paper-review came off."
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Review focus 2: text the composer gets back (W02's hand-back here)
  // shows its skill as a chip again.
  it("shows the chip again for a message handed back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              skills: [
                {
                  name: "paper-review",
                  description: "Review a paper",
                  source: "global",
                },
              ],
            })
          )
      )
    );
    try {
      const { container, textarea, type } = await mount(
        {},
        { threadValues: goalValues("active") }
      );
      type("/paper-review hi");
      const sent = submits()[0].values as { messages: Message[] };
      act(() => {
        stream.setMessages([...sent.messages]);
      });
      act(() => {
        stream.emitError(
          new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
        );
      });
      await waitFor(() =>
        expect(
          container.querySelector('[data-slot="composer-chip"]')?.textContent
        ).toBe("paper-review")
      );
      expect(textarea.value).toBe("hi");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("has no Goal row where goals aren't supported", async () => {
    const { textarea } = await mount({}, { goals: false });
    act(() => textarea.focus());
    fireEvent.change(textarea, { target: { value: "/" } });
    await waitFor(() =>
      expect(screen.getAllByRole("option").length).toBeGreaterThan(0)
    );
    const rows = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(rows[0]).toContain("Model");
    expect(rows.some((r) => r.startsWith("Goal"))).toBe(false);
  });

  // The Goal page: every /goal command the core takes on this goal.
  describe("the Goal page", () => {
    async function openGoalPage(textarea: HTMLTextAreaElement) {
      act(() => textarea.focus());
      fireEvent.change(textarea, { target: { value: "/go" } });
      await waitFor(() =>
        expect(screen.getAllByRole("option")).toHaveLength(1)
      );
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(screen.getByRole("listbox", { name: "Goal" })).toBeTruthy();
    }
    const labels = () =>
      screen.getAllByRole("option").map((o) => o.textContent ?? "");

    it("offers what the goal's status allows", async () => {
      const { textarea } = await mount(
        {},
        { threadValues: goalValues("active") }
      );
      await openGoalPage(textarea);
      const rows = labels();
      expect(rows).toHaveLength(5);
      [
        "Amend the goal…",
        "Pause",
        "Set a new goal…",
        "Clear",
        "Show details",
      ].forEach((label, i) => expect(rows[i].startsWith(label)).toBe(true));
      expect(textarea.value).toBe("");
    });

    it("runs Pause as a goal request, and queues it while busy", async () => {
      const { textarea } = await mount(
        {},
        { threadValues: goalValues("active") }
      );
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(submits()).toHaveLength(1);
      expect(submits()[0].values).toMatchObject({
        messages: [],
        goal_request: { kind: "pause" },
      });
      expect(screen.queryByRole("listbox")).toBeNull();
      // Busy: it waits in the queue like a typed /goal pause.
      act(() => {
        stream.setLoading(true);
      });
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(submits()).toHaveLength(1);
      expect(screen.getByLabelText("Queued messages").textContent).toContain(
        "/goal pause"
      );
    });

    it("opens the goal's details from Show details", async () => {
      const { textarea } = await mount(
        {},
        { threadValues: goalValues("active") }
      );
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() =>
        expect(getLastProps<{ open: boolean }>("GoalPill")?.open).toBe(true)
      );
      expect(submits()).toHaveLength(0);
    });

    // Independent review, checkpoint A: the typed word is gone once the
    // page opened, so a command that can't run says so.
    it("says so when a command chosen there can't run now", async () => {
      const { textarea } = await mount(
        {
          workspace: {
            ...mockWorkspace(),
            refreshing: true,
            isReady: () => false,
          },
        },
        { threadValues: goalValues("active") }
      );
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(submits()).toHaveLength(0);
      expect(toast.info).toHaveBeenCalledWith(
        "This chat can't run commands yet. Try again in a moment."
      );
    });

    // Goal mode: Set a goal… / Amend the goal… put a solid chip at the
    // start of the box, the send button and the placeholder say what Enter
    // does, and what is written goes out as the goal request.
    // The composer's own chip (a queued message's is in its row).
    const chipOf = (container: HTMLElement) =>
      container
        .querySelector("form")!
        .querySelector('[data-slot="composer-chip"]');
    const write = (textarea: HTMLTextAreaElement, text: string) =>
      fireEvent.change(textarea, { target: { value: text } });

    it("enters goal mode from Set a goal…, sends what is written as the goal, and leaves the mode", async () => {
      const { container, textarea } = await mount();
      await openGoalPage(textarea);
      expect(labels()).toHaveLength(1);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(chipOf(container)?.textContent).toBe("Goal");
      expect(chipOf(container)?.getAttribute("data-kind")).toBe("goal");
      expect(textarea.value).toBe("");
      expect(textarea.placeholder).toBe(
        "Describe the goal; its criteria are drafted for you to review…"
      );
      expect(screen.getByRole("button", { name: "Set goal" })).toBeTruthy();
      expect(container.querySelector('[data-mode="goal"]')).toBeTruthy();
      // Its glow stays, and focus still shows (agent's nit, checkpoint B).
      expect(
        container.querySelector('[data-mode="goal"]')!.className.split(" ")
      ).toContain("focus-within:ring-2");
      expect(
        document.getElementById(textarea.getAttribute("aria-describedby")!)
          ?.textContent
      ).toBe(
        "Setting a goal: what you write is the goal. Escape leaves goal mode."
      );
      write(textarea, "write x");
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(submits()).toHaveLength(1);
      expect(submits()[0].values).toMatchObject({
        messages: [],
        goal_request: { kind: "create", objective: "write x" },
      });
      expect(chipOf(container)).toBeNull();
      expect(container.querySelector("[data-mode]")).toBeNull();
      expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
      // Typed out afterwards, /goal is text again.
      write(textarea, "/goal y");
      expect(chipOf(container)).toBeNull();
      expect(textarea.value).toBe("/goal y");
    });

    it("keeps the text after the typed word as the goal's, the caret at its end", async () => {
      const { container, textarea } = await mount();
      act(() => textarea.focus());
      write(textarea, "/go write x");
      textarea.setSelectionRange(3, 3);
      fireEvent.select(textarea);
      await waitFor(() =>
        expect(screen.getAllByRole("option")).toHaveLength(1)
      );
      fireEvent.keyDown(textarea, { key: "Enter" });
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(chipOf(container)?.textContent).toBe("Goal");
      expect(textarea.value).toBe("write x");
      expect(textarea.selectionStart).toBe("write x".length);
    });

    it("enters amend mode from Amend the goal…, and sends what is written as the feedback", async () => {
      const { container, textarea } = await mount(
        {},
        { threadValues: goalValues("active") }
      );
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(chipOf(container)?.textContent).toBe("Amend goal");
      expect(chipOf(container)?.getAttribute("data-kind")).toBe("amend");
      expect(textarea.placeholder).toBe("What should change in the goal?");
      expect(screen.getByRole("button", { name: "Amend goal" })).toBeTruthy();
      expect(
        document.getElementById(textarea.getAttribute("aria-describedby")!)
          ?.textContent
      ).toBe(
        "Amending the goal: what you write is the change. Escape leaves amend mode."
      );
      write(textarea, "make it shorter");
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(submits()).toHaveLength(1);
      expect(submits()[0].values).toMatchObject({
        messages: [],
        goal_request: { kind: "amend", feedback: "make it shorter" },
      });
      expect(chipOf(container)).toBeNull();
    });

    // A goal request carries no skill.
    it("drops the skill chip when goal mode starts, and says so", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                skills: [
                  {
                    name: "paper-review",
                    description: "Review a paper",
                    source: "global",
                  },
                ],
              })
            )
        )
      );
      try {
        const { container, textarea } = await mount();
        act(() => textarea.focus());
        write(textarea, "/paper-review hi");
        await waitFor(() =>
          expect(chipOf(container)?.textContent).toBe("paper-review")
        );
        await openGoalPage(textarea);
        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(toast.info).toHaveBeenCalledWith(
          "A goal doesn't take skills, so /paper-review came off."
        );
        expect(chipOf(container)?.textContent).toBe("Goal");
        write(textarea, "write x");
        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(submits()[0].values).toMatchObject({
          messages: [],
          goal_request: { kind: "create", objective: "write x" },
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("refuses an empty goal and a goal that reads as another command", async () => {
      const animate = vi.fn(() => ({ onfinish: null, cancel: () => {} }));
      Object.defineProperty(Element.prototype, "animate", {
        configurable: true,
        value: animate,
      });
      try {
        const { container, textarea } = await mount(
          {},
          { threadValues: goalValues("active") }
        );
        await openGoalPage(textarea);
        fireEvent.keyDown(textarea, { key: "ArrowDown" });
        fireEvent.keyDown(textarea, { key: "ArrowDown" });
        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(chipOf(container)?.textContent).toBe("Goal");
        // Nothing written: the box nudges and says what to write.
        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(submits()).toHaveLength(0);
        expect(toast.info).toHaveBeenCalledWith("Describe the goal first.", {
          id: "goal-mode-hint",
        });
        const box = container.querySelector('[data-mode="goal"]');
        expect(animate.mock.contexts).toContain(box);
        // A word the core reads as another /goal command.
        write(textarea, "pause");
        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(submits()).toHaveLength(0);
        expect(toast.warning).toHaveBeenCalledWith(
          "“pause” is a /goal command; describe the goal in more words.",
          { id: "goal-mode-hint" }
        );
        expect(chipOf(container)?.textContent).toBe("Goal");
        expect(textarea.value).toBe("pause");
        // Amend with nothing written (the menu is off in goal mode: out of
        // it first).
        fireEvent.keyDown(textarea, { key: "Escape" });
        await openGoalPage(textarea);
        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(chipOf(container)?.textContent).toBe("Amend goal");
        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(submits()).toHaveLength(0);
        expect(toast.info).toHaveBeenCalledWith(
          "Say what should change in the goal first.",
          { id: "goal-mode-hint" }
        );
      } finally {
        delete (Element.prototype as { animate?: unknown }).animate;
      }
    });

    it("leaves goal mode with Escape, Backspace at the start, or the chip's button, keeping the text", async () => {
      const { container, textarea } = await mount();
      const enter = async () => {
        await openGoalPage(textarea);
        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(chipOf(container)?.textContent).toBe("Goal");
      };
      await enter();
      write(textarea, "write x");
      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(chipOf(container)).toBeNull();
      expect(textarea.value).toBe("write x");
      expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
      await enter();
      write(textarea, "write y");
      textarea.setSelectionRange(0, 0);
      fireEvent.keyDown(textarea, { key: "Backspace" });
      expect(chipOf(container)).toBeNull();
      expect(textarea.value).toBe("write y");
      await enter();
      write(textarea, "write z");
      fireEvent.click(screen.getByRole("button", { name: "Leave goal mode" }));
      expect(chipOf(container)).toBeNull();
      expect(textarea.value).toBe("write z");
      expect(submits()).toHaveLength(0);
    });

    // Review focus 2: text put back from outside (W02's hand-back here)
    // that no longer starts with the mode's words ends the mode.
    it("leaves goal mode when outside text replaces the composer's", async () => {
      const { container, textarea, type } = await mount(
        {},
        { threadValues: { messages: [] } }
      );
      type("hello");
      const sent = submits()[0].values as { messages: Message[] };
      act(() => {
        stream.setMessages([...sent.messages]);
      });
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "Enter" });
      write(textarea, "write x");
      act(() => {
        stream.emitError(
          new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
        );
      });
      expect(chipOf(container)).toBeNull();
      expect(textarea.value).toBe("hello\n\n/goal write x");
      expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
    });

    it("shows a queued goal as a chip in its row", async () => {
      const { container, textarea } = await mount();
      act(() => {
        stream.setLoading(true);
      });
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "Enter" });
      write(textarea, "write x");
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(submits()).toHaveLength(0);
      expect(chipOf(container)).toBeNull();
      const queue = screen.getByLabelText("Queued messages");
      expect(
        queue.querySelector('[data-slot="composer-chip"]')?.textContent
      ).toBe("Goal");
      expect(queue.textContent).toContain("write x");
    });

    // Agent #8 (checkpoint B): goal mode with nothing written is an empty
    // draft to a hand-back ("hello\n\n/goal" showed a /goal the user never
    // saw as text).
    it("takes goal mode with nothing written as an empty draft for a hand-back", async () => {
      const { container, textarea, type } = await mount(
        {},
        { threadValues: { messages: [] } }
      );
      type("hello");
      const sent = submits()[0].values as { messages: Message[] };
      act(() => {
        stream.setMessages([...sent.messages]);
      });
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(chipOf(container)?.textContent).toBe("Goal");
      act(() => {
        stream.emitError(
          new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
        );
      });
      expect(textarea.value).toBe("hello");
      expect(chipOf(container)).toBeNull();
    });

    // Agent, confirm round B (R2, T3): a hand-back that leaves goal mode's
    // text as it was (but trimmed) keeps the mode; a trailing space ended it.
    it("keeps goal mode when a hand-back leaves its text as it was", async () => {
      const { container, textarea, type } = await mount(
        {},
        { threadValues: goalValues("active") }
      );
      type("/goal write x");
      expect(submits()).toHaveLength(1);
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(chipOf(container)?.textContent).toBe("Goal");
      write(textarea, "write y ");
      act(() => {
        stream.emitError(
          new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
        );
      });
      expect(chipOf(container)?.textContent).toBe("Goal");
      expect(textarea.value).toBe("write y");
      expect(notSent()).toContain("/goal write x");
    });

    // Confirm round N4: an open page took its word out of the box, which
    // looked empty, so a finished task was reported while the user was on
    // the page. An open page holds reports, as typed text does.
    it("holds auto-reports while a page is open", async () => {
      agents.tasks = [
        { ...FINISHED, status: "running", liveStatus: "running" },
      ];
      agents.autoNotify = true;
      const { textarea } = await mount(
        {},
        { threadValues: goalValues("active") }
      );
      await openGoalPage(textarea);
      expect(textarea.value).toBe("");
      agents.tasks = [FINISHED];
      act(() => {
        stream.setMessages([...(goalValues("active").messages as Message[])]);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      expect(submits()).toHaveLength(0);
      // Back (its word in the box again) it still waits; with the box
      // cleared it goes.
      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(textarea.value).toBe("/go");
      expect(submits()).toHaveLength(0);
      fireEvent.change(textarea, { target: { value: "" } });
      await waitFor(() => expect(submits()).toHaveLength(1));
    });

    // The owner's call (2026-10-25): a queued goal pulled back to edit comes
    // back in goal mode, as its queued row showed it.
    it("brings a queued goal back in goal mode", async () => {
      const { container, textarea } = await mount();
      act(() => {
        stream.setLoading(true);
      });
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "Enter" });
      write(textarea, "write x");
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(submits()).toHaveLength(0);
      expect(chipOf(container)).toBeNull();
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(chipOf(container)?.textContent).toBe("Goal");
      expect(container.querySelector('[data-mode="goal"]')).toBeTruthy();
      expect(textarea.value).toBe("write x");
    });

    it("brings a queued amendment back in amend mode", async () => {
      const { container, textarea } = await mount(
        {},
        { threadValues: goalValues("active") }
      );
      act(() => {
        stream.setLoading(true);
      });
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "Enter" });
      write(textarea, "make it shorter");
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(chipOf(container)).toBeNull();
      // The row's Edit, the other way back.
      fireEvent.click(
        within(screen.getByLabelText("Queued messages"))
          .getByText("Edit message")
          .closest("button")!
      );
      expect(chipOf(container)?.textContent).toBe("Amend goal");
      expect(textarea.value).toBe("make it shorter");
    });

    // The box holds the goal: a "/" there is text, not the menu.
    it("keeps a typed / as text in goal mode", async () => {
      const { container, textarea } = await mount();
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "Enter" });
      write(textarea, "/mo");
      await act(async () => {});
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(chipOf(container)?.textContent).toBe("Goal");
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(submits()[0].values).toMatchObject({
        goal_request: { kind: "create", objective: "/mo" },
      });
    });

    // The model pill still opens its page in goal mode, which stays.
    it("opens the Model page from the model pill in goal mode, and stays in it", async () => {
      const { container, textarea } = await mount();
      await openGoalPage(textarea);
      fireEvent.keyDown(textarea, { key: "Enter" });
      write(textarea, "write x");
      fireEvent.click(
        screen.getByRole("button", { name: "Change model for this chat" })
      );
      expect(screen.getByRole("listbox", { name: "Model" })).toBeTruthy();
      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(chipOf(container)?.textContent).toBe("Goal");
      expect(textarea.value).toBe("write x");
    });
  });

  it("sends /goal <objective> as a goal request, not a message", async () => {
    const { textarea, type } = await mount();
    type("/goal write the report");
    expect(submits()).toHaveLength(1);
    expect(submits()[0].values).toEqual({
      messages: [],
      goal_request: {
        kind: "create",
        id: expect.stringMatching(/^[0-9a-f]{32}$/),
        objective: "write the report",
      },
    });
    expect(textarea.value).toBe("");
  });

  it("opens the goal's details for /goal, with no run", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("active") }
    );
    type("/goal");
    expect(getLastProps<{ open: boolean }>("GoalPill")?.open).toBe(true);
    expect(submits()).toHaveLength(0);
    expect(textarea.value).toBe("");
  });

  // Left open when its goal went away, the panel would pop up by itself
  // for the next goal.
  it("closes the goal's details when the goal goes away", async () => {
    const { type } = await mount({}, { threadValues: goalValues("active") });
    type("/goal");
    expect(getLastProps<{ open: boolean }>("GoalPill")?.open).toBe(true);
    getActiveMockClient().setThreadState("t-1", {
      next: [],
      tasks: [],
      values: { messages: [] },
    });
    act(() => {
      stream.emitCustomEvent({
        type: "goal_state",
        change: "cleared",
        status: "active",
      });
    });
    await waitFor(() =>
      expect(getLastProps<{ goal: unknown }>("GoalPill")?.goal).toBeNull()
    );
    expect(getLastProps<{ open: boolean }>("GoalPill")?.open).toBe(false);
  });

  it("says there is no goal for /goal show on a thread without one", async () => {
    const { type } = await mount();
    type("/goal show");
    expect(toast.info).toHaveBeenCalledWith("No goal set for this thread.");
    expect(submits()).toHaveLength(0);
  });

  // A refusal keeps the text: an objective over the limit is to be
  // shortened, and amend feedback is needed again once the goal can take it.
  it("refuses /goal pause on a paused goal in the core's words, keeping the text", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("paused") }
    );
    type("/goal pause");
    expect(toast.warning).toHaveBeenCalledWith(
      "The goal is paused; only an active goal can be paused."
    );
    expect(submits()).toHaveLength(0);
    expect(textarea.value).toBe("/goal pause");
  });

  it("aims /goal pause at the thread's goal", async () => {
    const { type } = await mount({}, { threadValues: goalValues("active") });
    type("/goal pause");
    expect(submits()[0].values?.goal_request).toEqual({
      kind: "pause",
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      target: "goal:abc",
    });
  });

  it("shows how to amend for /goal amend with nothing after it, keeping the text", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("active") }
    );
    type("/goal amend");
    expect(toast.warning).toHaveBeenCalledWith(
      "Usage: /goal amend <feedback>",
      {
        description: "revise the goal and its criteria",
      }
    );
    expect(submits()).toHaveLength(0);
    expect(textarea.value).toBe("/goal amend");
  });

  it("keeps /goal and its files when files are attached", async () => {
    const files = [{ name: "a.txt", path: "/a.txt", size: 1 }];
    const { textarea } = await mount({ draftSeed: { text: "/goal x", files } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(toast.warning).toHaveBeenCalledWith(
      "A goal can't carry files; send them in a message."
    );
    expect(submits()).toHaveLength(0);
    expect(textarea.value).toBe("/goal x");
    expect(screen.getByText("a.txt")).toBeTruthy();
  });

  it("queued /goal drains as a goal request", async () => {
    const { type } = await mount({}, { threadValues: goalValues("active") });
    act(() => {
      stream.setLoading(true);
    });
    type("/goal write x");
    expect(submits()).toHaveLength(0);
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => expect(submits()).toHaveLength(1));
    expect(submits()[0].values).toMatchObject({
      messages: [],
      goal_request: { kind: "create", objective: "write x" },
    });
  });

  // Nothing went out, so the queue must not wait for a run that never
  // starts: the refused command comes back to the composer and the next
  // queued message goes.
  it("brings a refused queued /goal back and keeps the queue moving", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("paused") }
    );
    act(() => {
      stream.setLoading(true);
    });
    type("/goal pause");
    type("hello after");
    expect(submits()).toHaveLength(0);
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => expect(submits()).toHaveLength(1));
    expect(toast.warning).toHaveBeenCalledWith(
      "The goal is paused; only an active goal can be paused."
    );
    expect(submits()[0].values?.messages?.[0]?.content).toBe("hello after");
    expect(textarea.value).toBe("/goal pause");
  });

  // A /goal glued onto a draft would turn the draft into the command's
  // text (Enter would send it all as one goal): a draft stays as it is, and
  // a refused command that can't come back is named instead.
  it("names refused queued commands instead of gluing them onto a draft", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("paused") }
    );
    act(() => {
      stream.setLoading(true);
    });
    type("/goal pause");
    type("/goal amend x");
    fireEvent.change(textarea, { target: { value: "my draft" } });
    act(() => {
      stream.setLoading(false);
    });
    // One notice for the fold, the commands in their order, each on its own.
    await waitFor(() => expect(notSent()).toEqual(["2 commands"]));
    const { container } = showNotSent();
    expect(
      Array.from(container.querySelectorAll("li")).map(
        (li) => li.querySelector("span")?.textContent
      )
    ).toEqual(["/goal pause", "/goal amend x"]);
    expect(textarea.value).toBe("my draft");
    expect(submits()).toHaveLength(0);
  });
  it("brings back only the first of two refused queued commands", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("paused") }
    );
    act(() => {
      stream.setLoading(true);
    });
    type("/goal pause");
    type("/goal amend x");
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => expect(textarea.value).toBe("/goal pause"));
    expect(notSent()).toContain("/goal amend x");
    expect(submits()).toHaveLength(0);
  });

  // Queued while goal support was unknown, /goal show is read when it
  // drains: it opens the details and is done, not handed back.
  it("opens the details for a drained /goal show and keeps nothing", async () => {
    let answer: (value: unknown) => void = () => {};
    getActiveMockClient().assistants.getSchemas.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    const { textarea, type } = await mount(
      {},
      { goals: false, threadValues: goalValues("active") }
    );
    act(() => {
      stream.setLoading(true);
    });
    type("/goal show");
    await act(async () => {
      answer(WITH_GOAL);
    });
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() =>
      expect(getLastProps<{ open: boolean }>("GoalPill")?.open).toBe(true)
    );
    expect(textarea.value).toBe("");
    expect(submits()).toHaveLength(0);
  });

  // Queued while goal support was unknown, "/goal …" with files is refused
  // when it drains, as Enter refuses it: it comes back with its files
  // instead of going out as a goal request without them (CodeRabbit, #102).
  async function queueGoalWithFiles() {
    let answer: (value: unknown) => void = () => {};
    getActiveMockClient().assistants.getSchemas.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    const files = [{ name: "a.txt", path: "/a.txt", size: 1 }];
    const view = await mount(
      { draftSeed: { text: "/goal write x", files } },
      { goals: false }
    );
    act(() => {
      stream.setLoading(true);
    });
    fireEvent.keyDown(view.textarea, { key: "Enter" });
    expect(view.textarea.value).toBe("");
    await act(async () => {
      answer(WITH_GOAL);
    });
    return view;
  }

  it("hands a drained /goal with files back, files and all", async () => {
    const { textarea } = await queueGoalWithFiles();
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => expect(textarea.value).toBe("/goal write x"));
    expect(submits()).toHaveLength(0);
    expect(toast.warning).toHaveBeenCalledWith(
      "A goal can't carry files; send them in a message."
    );
    expect(screen.getByText("a.txt")).toBeTruthy();
  });

  // With a draft in the composer the command goes to the "Not sent" notice,
  // and its files go with it (named there): put on the draft, they would be
  // sent with an unrelated message (Codex on the CodeRabbit fix).
  it("leaves a refused command's files with it, not on the draft", async () => {
    const { textarea } = await queueGoalWithFiles();
    // The draft stays as typed: a rewrite would drop its final line break
    // and move the caret (independent review of 854007e).
    fireEvent.change(textarea, { target: { value: "my draft\n" } });
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => expect(notSent()).toEqual(["/goal write x"]));
    expect(submits()).toHaveLength(0);
    expect(textarea.value).toBe("my draft\n");
    expect(screen.queryByText("a.txt")).toBeNull();
    const { container } = showNotSent();
    expect(container.textContent).toContain("Attached: a.txt");
  });

  // The backend refusing a goal request's run (W02's fold): the /goal text
  // comes back only to an empty composer.
  it("keeps the draft when a refused goal request comes back", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("active") }
    );
    type("/goal pause");
    expect(submits()).toHaveLength(1);
    fireEvent.change(textarea, { target: { value: "next thing" } });
    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });
    expect(textarea.value).toBe("next thing");
    expect(notSent()).toContain("/goal pause");
  });

  // Only what would go out as a goal now is a command: on a backend without
  // goals "/goal …" was a message, and comes back as one (W02's fold).
  it("folds back a refused message that starts with /goal on a backend without goals", async () => {
    const { textarea, type } = await mount(
      {},
      { goals: false, threadValues: { messages: [] } }
    );
    type("/goal write x");
    const sent = submits()[0].values as { messages: Message[] };
    act(() => {
      stream.setMessages([...sent.messages]);
    });
    fireEvent.change(textarea, { target: { value: "next" } });
    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });
    expect(textarea.value).toBe("/goal write x\n\nnext");
    expect(toast.info).not.toHaveBeenCalled();
  });

  // The composer is read by the rule Enter uses now: sent as a message
  // while goal support was unknown, "/goal write report" reads as a goal
  // command once support is in, so glued ahead of a draft it would make the
  // draft part of one goal. It is named instead, with its text to copy.
  it("never glues a text that now reads as a goal command onto a draft", async () => {
    let answer: (value: unknown) => void = () => {};
    getActiveMockClient().assistants.getSchemas.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    const { textarea, type } = await mount(
      {},
      { goals: false, threadValues: { messages: [] } }
    );
    type("/goal write report");
    const sent = submits()[0].values as { messages: Message[] };
    expect(sent.messages[0]?.content).toBe("/goal write report");
    act(() => {
      stream.setMessages([...sent.messages]);
    });
    await act(async () => {
      answer(WITH_GOAL);
    });
    fireEvent.change(textarea, { target: { value: "next" } });
    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });
    expect(textarea.value).toBe("next");
    expect(notSent()).toEqual(["/goal write report"]);
  });

  // The notice stays until closed and holds all of the text, to read
  // (it scrolls) and to copy; it closes only once the copy worked.
  // The notice stays until closed and holds the whole text, to read (it
  // scrolls) and to copy, one command at a time: copied together they would
  // read as one goal.
  it("lists a command that can't come back to read and copy", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("paused") }
    );
    act(() => {
      stream.setLoading(true);
    });
    const text = `/goal amend ${"tighten the criteria ".repeat(
      30
    )}\nand name the file`;
    type(text);
    fireEvent.change(textarea, { target: { value: "my draft" } });
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => expect(notSent()).toHaveLength(1));
    expect(textarea.value).toBe("my draft");
    expect(notSentToast().duration).toBe(Infinity);
    const { container } = showNotSent();
    // A list for VoiceOver (Safari drops it without bullets), focusable so a
    // keyboard can scroll a long command into view.
    const list = container.querySelector("ul");
    expect(list?.className).toContain("overflow-y-auto");
    expect(list?.getAttribute("role")).toBe("list");
    expect(list?.getAttribute("tabindex")).toBe("0");
    expect(container.querySelector("li span")?.textContent).toBe(text.trim());
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /^Copy \/goal amend/ })
      );
    });
    expect(clipboard.copied).toEqual([text.trim()]);
    // Said on the button, not in a toast that would cover the notice.
    expect(
      screen.getByRole("button", { name: /^Copied \/goal amend/ }).textContent
    ).toBe("Copied");
    expect(container.querySelector('li [role="status"]')?.textContent).toBe(
      "Copied."
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.dismiss).not.toHaveBeenCalled();
  });

  it("copies one command at a time", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("paused") }
    );
    act(() => {
      stream.setLoading(true);
    });
    type("/goal pause");
    type("/goal amend x");
    fireEvent.change(textarea, { target: { value: "my draft" } });
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => expect(notSent()).toEqual(["2 commands"]));
    showNotSent();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy 2 of 2: /goal amend x" })
      );
    });
    expect(clipboard.copied).toEqual(["/goal amend x"]);
  });
  it("says when Copy fails", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("paused") }
    );
    act(() => {
      stream.setLoading(true);
    });
    type("/goal amend x");
    fireEvent.change(textarea, { target: { value: "my draft" } });
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => expect(notSent()).toEqual(["/goal amend x"]));
    clipboard.works = false;
    showNotSent();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy /goal amend x" })
      );
    });
    expect(toast.dismiss).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the text.");
  });
  // Several notices can stack: each Copy says what it copies.
  // Commands can share a first line (two amends): their Copy buttons say
  // which one they are.
  it("tells apart Copy buttons whose commands start alike", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("paused") }
    );
    act(() => {
      stream.setLoading(true);
    });
    type("/goal amend\nuse section A");
    type("/goal amend\nuse section B");
    fireEvent.change(textarea, { target: { value: "my draft" } });
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => expect(notSent()).toEqual(["2 commands"]));
    const { container } = showNotSent();
    expect(
      Array.from(container.querySelectorAll("li button")).map((b) =>
        b.getAttribute("aria-label")
      )
    ).toEqual(["Copy 1 of 2: /goal amend", "Copy 2 of 2: /goal amend"]);
  });

  // Each Copy says what it copies, and is a phone-sized target.
  it("names what each Copy copies", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("paused") }
    );
    act(() => {
      stream.setLoading(true);
    });
    type("/goal amend x");
    fireEvent.change(textarea, { target: { value: "my draft" } });
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => expect(notSent()).toEqual(["/goal amend x"]));
    showNotSent();
    const copy = screen.getByRole("button", { name: "Copy /goal amend x" });
    expect(copy.className).toContain("max-md:min-h-11");
  });
  it("cuts a long first line in the title without splitting a character", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("paused") }
    );
    act(() => {
      stream.setLoading(true);
    });
    type(`/goal amend ${"😀".repeat(100)}`);
    fireEvent.change(textarea, { target: { value: "my draft" } });
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => expect(notSent()).toHaveLength(1));
    const [title] = notSent();
    expect(Array.from(title)).toHaveLength(80);
    expect(title.endsWith("😀…")).toBe(true);
  });

  // Unknown support may turn out on before Enter: until it is known, a
  // "/goal …" text is kept apart from a draft as a command would be.
  it("keeps a /goal text apart from a draft while goal support is unknown", async () => {
    getActiveMockClient().assistants.getSchemas.mockImplementation(
      () => new Promise(() => {})
    );
    const { textarea, type } = await mount(
      {},
      { goals: false, threadValues: { messages: [] } }
    );
    type("/goal write report");
    const sent = submits()[0].values as { messages: Message[] };
    act(() => {
      stream.setMessages([...sent.messages]);
    });
    fireEvent.change(textarea, { target: { value: "next" } });
    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });
    expect(textarea.value).toBe("next");
    expect(notSent()).toEqual(["/goal write report"]);
  });
  // Named as not sent, it must not also be said to be back.
  it("doesn't say a refused goal request is back in the composer when it isn't", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("active") }
    );
    type("/goal amend keep section 3");
    fireEvent.change(textarea, { target: { value: "next thing" } });
    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });
    expect(notSent()).toContain("/goal amend keep section 3");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringContaining("back in the composer")
    );
  });

  // A gone thread's unsent message and composer go to a new chat: a /goal
  // command there must not be glued onto the rest either.
  it("folds a gone thread's composer for a new chat without gluing commands", async () => {
    let getSnapshot:
      | ((unsent?: string | null) => {
          text: string;
          files: unknown[];
          unsentBack: boolean;
        })
      | null = null;
    const { textarea, type } = await mount(
      {
        onComposerSnapshotReady: (fn) => {
          getSnapshot = fn;
        },
      },
      { threadValues: goalValues("active") }
    );
    act(() => {
      stream.setLoading(true);
    });
    type("/goal pause");
    type("check the logs");
    fireEvent.change(textarea, { target: { value: "my draft" } });
    let fold: { text: string; unsentBack: boolean } | undefined;
    act(() => {
      fold = getSnapshot!("/goal amend x");
    });
    expect(fold?.text).toBe("check the logs\n\nmy draft");
    expect(fold?.unsentBack).toBe(false);
    expect(notSent()).toEqual(["2 commands"]);
  });

  // A gone scheduled task's thread seeds a new chat on the chat graph,
  // where goals are on: "/goal …" there reads as a command, even though it
  // was a message on the old thread.
  it("folds a gone scheduled task's composer by the new chat's rule", async () => {
    getActiveMockClient().setThreadRecord("t-1", {
      metadata: { graph_id: "scheduler" },
    });
    let getSnapshot:
      | ((unsent?: string | null) => { text: string; unsentBack: boolean })
      | null = null;
    const { type } = await mount(
      {
        onComposerSnapshotReady: (fn) => {
          getSnapshot = fn;
        },
      },
      { threadValues: { messages: [] } }
    );
    act(() => {
      stream.setLoading(true);
    });
    type("and email it to the team");
    let fold: { text: string; unsentBack: boolean } | undefined;
    act(() => {
      fold = getSnapshot!("/goal write the weekly digest");
    });
    expect(fold?.text).toBe("and email it to the team");
    expect(fold?.unsentBack).toBe(false);
    expect(notSent()).toEqual(["/goal write the weekly digest"]);
  });

  it("hands a refused goal request back to an empty composer", async () => {
    const { textarea, type } = await mount(
      {},
      { threadValues: goalValues("active") }
    );
    type("/goal pause");
    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });
    expect(textarea.value).toBe("/goal pause");
  });

  it("handles /goal at once while the agent works", async () => {
    const { type } = await mount({}, { threadValues: goalValues("active") });
    act(() => {
      stream.setLoading(true);
    });
    type("/goal");
    expect(getLastProps<{ open: boolean }>("GoalPill")?.open).toBe(true);
    expect(screen.queryByLabelText("Queued messages")).toBeNull();
  });

  // The scheduler graph has no goal middleware: a goal request there would
  // be dropped and the agent would answer its last turn again.
  it("a scheduled task's thread takes /goal as a message", async () => {
    getActiveMockClient().setThreadRecord("t-1", {
      metadata: { graph_id: "scheduler" },
    });
    const { type } = await mount({}, { threadValues: { messages: [] } });
    type("/goal write x");
    expect(submits()).toHaveLength(1);
    expect(submits()[0].values?.messages?.[0]?.content).toBe("/goal write x");
  });

  // Until an open thread's own metadata names its graph, a scheduled
  // task's thread would pass for the chat graph's.
  it("takes no /goal on an open thread before its metadata is in", async () => {
    getActiveMockClient().threads.get.mockImplementation(
      () => new Promise(() => {})
    );
    const { textarea, type } = await mount(
      {},
      { threadValues: { messages: [] } }
    );
    type("/goal show");
    expect(toast.info).not.toHaveBeenCalled();
    expect(textarea.value).toBe("/goal show");
    expect(submits()).toHaveLength(0);
  });

  it("unsupported: /goal goes out as a message", async () => {
    const { type } = await mount({}, { goals: false });
    type("/goal write x");
    expect(submits()).toHaveLength(1);
    expect(submits()[0].values?.messages?.[0]?.content).toBe("/goal write x");
  });

  it("auto-report and notify send followup", async () => {
    // Work that finishes after the thread's first look; what had finished
    // before it is a baseline and never replays.
    agents.tasks = [{ ...FINISHED, status: "running", liveStatus: "running" }];
    agents.autoNotify = true;
    await mount({}, { threadValues: { messages: [] } });
    expect(submits()).toHaveLength(0);
    agents.tasks = [FINISHED];
    act(() => {
      stream.setMessages([]);
    });
    await waitFor(() => expect(submits()).toHaveLength(1));
    expect(submits()[0].options.config?.configurable?.rubric_run).toEqual({
      mode: "followup",
      changes: [],
    });
  });

  // A report is a run with a message: sent while a goal's review (or any
  // question or approval) waits, it would drop what waits.
  // A new chat's first goal waits on its review before any message: the
  // review takes the page, not the welcome screen above it.
  it("shows a new chat's goal review without the welcome screen", async () => {
    await mount();
    expect(screen.getByText("Where research evolves")).toBeTruthy();
    act(() => {
      stream.setInterrupt({
        id: "int-goal",
        value: {
          type: "ask_user",
          questions: [
            {
              question: "Proposed acceptance criteria for the goal:",
              type: "multiple_choice",
              choices: [{ value: "Accept" }, { value: "Cancel" }],
            },
          ],
        },
      });
    });
    expect(screen.queryByText("Where research evolves")).toBeNull();
  });

  it("holds an auto-report while a question waits", async () => {
    agents.tasks = [{ ...FINISHED, status: "running", liveStatus: "running" }];
    agents.autoNotify = true;
    await mount({}, { threadValues: { messages: [] } });
    const review = {
      id: "int-goal",
      value: {
        type: "ask_user",
        questions: [
          {
            question: "Proposed acceptance criteria for the goal:",
            type: "multiple_choice",
            choices: [{ value: "Accept" }, { value: "Cancel" }],
          },
        ],
      },
    };
    // The server holds the review too, as it does while one waits.
    getActiveMockClient().setThreadState("t-1", {
      next: ["GoalMiddleware.before_agent"],
      tasks: [{ interrupts: [review] }],
      values: { messages: [] },
    });
    act(() => {
      stream.setInterrupt(review);
    });
    agents.tasks = [FINISHED];
    act(() => {
      stream.setMessages([]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(submits()).toHaveLength(0);
    getActiveMockClient().setThreadState("t-1", {
      next: [],
      tasks: [],
      values: { messages: [] },
    });
    act(() => {
      stream.setInterrupt(undefined);
    });
    await waitFor(() => expect(submits()).toHaveLength(1));
  });

  // Notify is a run with a message too: it would drop a waiting review.
  it("holds Notify main chat while a question waits", async () => {
    let notify: MainChatReporter | null = null;
    await mount(
      {
        onNotifyReady: (fn) => {
          notify = fn;
        },
      },
      { threadValues: { messages: [] } }
    );
    const review = {
      id: "int-goal",
      value: {
        type: "ask_user",
        questions: [
          {
            question: "Proposed acceptance criteria for the goal:",
            type: "multiple_choice",
            choices: [{ value: "Accept" }, { value: "Cancel" }],
          },
        ],
      },
    };
    getActiveMockClient().setThreadState("t-1", {
      next: ["GoalMiddleware.before_agent"],
      tasks: [{ interrupts: [review] }],
      values: { messages: [] },
    });
    act(() => {
      stream.setInterrupt(review);
    });
    await act(async () => {});
    let result: string | undefined;
    act(() => {
      result = notify!(FINISHED, "t-1");
    });
    expect(result).toBe("waiting");
    expect(submits()).toHaveLength(0);
  });

  it("sends a Notify main chat report as a followup turn", async () => {
    let notify: MainChatReporter | null = null;
    await mount(
      { onNotifyReady: (reporter) => (notify = reporter) },
      { threadValues: { messages: [] } }
    );
    let result: unknown;
    act(() => {
      result = notify?.(FINISHED, "t-1");
    });
    expect(result).toBe("sent");
    expect(submits().at(-1)?.options.config?.configurable?.rubric_run).toEqual({
      mode: "followup",
      changes: [],
    });
  });
});
