// @vitest-environment jsdom
//
// The follow-up box sends a message straight to a sub-agent's own thread, on
// the workspace assistant of that thread's graph.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const client = vi.hoisted(() => ({
  threads: { get: vi.fn(), getState: vi.fn() },
  runs: { wait: vi.fn() },
}));
const tasks = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("@/providers/ClientProvider", () => ({ useClient: () => client }));
vi.mock("nuqs", () => ({ useQueryState: () => ["main-1", vi.fn()] }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/hooks/useAsyncAgents", () => ({
  useAsyncAgents: () => ({
    tasks: tasks.list,
    loaded: true,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/app/hooks/useAutoNotify", () => ({
  useAutoNotify: () => [false, vi.fn()],
}));
vi.mock("@/app/hooks/useThreads", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stampThreadWorkspace: vi.fn(async () => {}),
}));

import { AgentsPanel } from "./AgentsPanel";
import {
  TestProjectsProvider,
  mockProjects,
  readyProjects,
} from "@/test/mockProjects";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";
import { NO_TASK_PROJECT_REASON } from "@/lib/threadBinding";

const KEY = "/home/you/projA";

function renderPanel(metadata: Record<string, unknown>) {
  tasks.list = [
    {
      task_id: "t1",
      agent_name: "paper-review",
      thread_id: "sub-1",
      run_id: "r1",
      status: "success",
      liveStatus: "success",
    },
  ];
  client.threads.get.mockResolvedValue({ thread_id: "sub-1", metadata });
  client.threads.getState.mockResolvedValue({
    values: { messages: [{ type: "human", content: "review it" }] },
    metadata: {},
  });
  client.runs.wait.mockResolvedValue({
    messages: [
      { type: "human", content: "one more" },
      { type: "ai", content: "Done." },
    ],
  });
  render(
    <TestProjectsProvider value={mockProjects(readyProjects(KEY))}>
      <AgentsPanel />
    </TestProjectsProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: /paper-review/ }));
}

describe("Agents panel follow-up", () => {
  it("runs on the task graph's assistant for the backend's folder", async () => {
    renderPanel({ graph_id: "expert-container-async", workspace_dir: KEY });
    const input = await screen.findByRole("textbox", {
      name: "Message this agent",
    });
    await waitFor(() =>
      expect((input as HTMLInputElement).disabled).toBe(false)
    );

    fireEvent.change(input, { target: { value: "one more" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(client.runs.wait).toHaveBeenCalledWith(
        "sub-1",
        workspaceAssistantId("expert-container-async", KEY),
        { input: { messages: [{ type: "human", content: "one more" }] } }
      )
    );
  });

  it("offers no follow-up on a task thread that records no project", async () => {
    renderPanel({ graph_id: "writing-agent" });

    expect(await screen.findByText(NO_TASK_PROJECT_REASON)).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "Message this agent" })
    ).toBeNull();
  });

  it("offers no follow-up on a task thread of another folder", async () => {
    renderPanel({ graph_id: "writing-agent", workspace_dir: "/srv/projB" });

    expect(await screen.findByText(/belongs to projB/)).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "Message this agent" })
    ).toBeNull();
    expect(client.runs.wait).not.toHaveBeenCalled();
  });
});
