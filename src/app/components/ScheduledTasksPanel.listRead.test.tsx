// @vitest-environment jsdom
//
// The panel with the real `useScheduledTasks` and the SDK client, `fetch`
// stubbed. A save or a pause shows the task the server returned and reads the
// list again; until that read is in, the list is locked and its old copy must
// not replace the task on the pane.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    deploymentUrl: "http://127.0.0.1:6174",
    langsmithApiKey: "",
  }),
}));

const A = "/home/you/projA";
const projectsHolder = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/providers/ProjectsProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/providers/ProjectsProvider")>()),
  useProjects: () => projectsHolder.value,
}));

vi.mock("@/app/hooks/useScheduledTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/hooks/useScheduledTasks")>()),
  useAssistantRecovery: () => () => {},
  useSchedulerGate: () => () => true,
}));

vi.mock("@/app/components/ScheduledTaskActivity", () => ({
  ScheduledTaskActivity: () => null,
}));

import { ScheduledTasksPanel } from "./ScheduledTasksPanel";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";
import { mockProjects, readyProjects } from "@/test/mockProjects";

function cron(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    cron_id: id,
    assistant_id: workspaceAssistantId("scheduler", A),
    thread_id: null,
    on_run_completed: "keep",
    end_time: null,
    schedule: "0 9 * * *",
    created_at: "2026-10-09T08:00:00+00:00",
    updated_at: "2026-10-09T08:00:00+00:00",
    payload: {},
    user_id: null,
    next_run_date: "2026-10-10T01:00:00+00:00",
    metadata: { run_kind: "scheduled_task", name, prompt: "Brief me" },
    timezone: "Asia/Shanghai",
    enabled: true,
    ...overrides,
  };
}

/** Every request waits until the test answers it with `reply`. */
function holdRequests() {
  const pending: Array<{
    method: string;
    path: string;
    reply: (body: unknown) => void;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve) =>
          pending.push({
            method: init?.method ?? "GET",
            path: new URL(String(input)).pathname,
            reply: (body) =>
              resolve(
                new Response(JSON.stringify(body), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                })
              ),
          })
        )
    )
  );
  /** The oldest request not yet answered, once it has been sent. */
  const next = async (method: string, path: string) => {
    let found: (typeof pending)[number] | undefined;
    await waitFor(() => {
      found = pending.find((r) => r.method === method && r.path === path);
      expect(
        found,
        JSON.stringify(pending.map((r) => [r.method, r.path]))
      ).toBeTruthy();
    });
    pending.splice(pending.indexOf(found!), 1);
    return found!;
  };
  return next;
}

const alpha = cron("a", "Alpha");
const beta = cron("b", "Beta");

/** Per write: what it sends, what the server returns, and how the pane
 *  shows the returned task. */
const writes = {
  save: {
    changed: cron("a", "Alpha briefing"),
    send: () => {
      fireEvent.click(
        screen.getByRole("button", { name: 'Edit scheduled task "Alpha"' })
      );
      fireEvent.change(screen.getByLabelText("Task name"), {
        target: { value: "Alpha briefing" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    },
    shown: () => screen.findByRole("heading", { name: "Alpha briefing" }),
  },
  pause: {
    changed: cron("a", "Alpha", { enabled: false }),
    send: () =>
      fireEvent.click(
        screen.getByRole("button", { name: 'Pause scheduled task "Alpha"' })
      ),
    shown: () =>
      screen.findByRole("button", { name: 'Resume scheduled task "Alpha"' }),
  },
};

beforeEach(() => {
  projectsHolder.value = mockProjects(readyProjects(A), { current: A });
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...new Intl.DateTimeFormat().resolvedOptions(),
    timeZone: "Asia/Shanghai",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ScheduledTasksPanel list read after a write", () => {
  it.each(["save", "pause"] as const)(
    "keeps the task a %s returned, and the list locked, until the list is read again",
    async (kind) => {
      const { changed, send, shown } = writes[kind];
      const next = holdRequests();
      render(<ScheduledTasksPanel />);
      const firstRead = await next("POST", "/runs/crons/search");
      await act(async () => firstRead.reply([alpha, beta]));
      fireEvent.click(await screen.findByRole("button", { name: /^Alpha/ }));

      send();
      const patch = await next("PATCH", "/runs/crons/a");
      await act(async () => patch.reply(changed));
      // The read after the write is still out: the pane shows what the
      // server returned, over the list's old copy, and the list waits.
      const reread = await next("POST", "/runs/crons/search");
      await shown();
      const betaRow = screen.getByRole("button", { name: /^Beta/ });
      expect(betaRow.hasAttribute("disabled")).toBe(true);

      await act(async () => reread.reply([changed, beta]));
      await waitFor(() => expect(betaRow.hasAttribute("disabled")).toBe(false));
      await shown();
    }
  );
});
