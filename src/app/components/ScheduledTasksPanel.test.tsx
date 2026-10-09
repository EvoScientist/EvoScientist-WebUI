// @vitest-environment jsdom
//
// Every schedule label names the time zone it runs in. A new task runs in the
// browser's time zone and an edit keeps the task's own, except for a task
// stored without one (made before #61, so UTC by accident): editing it says it
// moves to the browser's time zone, and it can be saved unchanged to do so.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ScheduledTask } from "@/app/hooks/useScheduledTasks";

const hook = vi.hoisted(() => ({
  tasks: [] as ScheduledTask[],
  updateScheduledTask: vi.fn(),
}));

vi.mock("@/app/hooks/useScheduledTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/hooks/useScheduledTasks")>()),
  useScheduledTasks: () => ({
    tasks: hook.tasks,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  updateScheduledTask: hook.updateScheduledTask,
}));

vi.mock("@/app/components/ScheduledTaskActivity", () => ({
  ScheduledTaskActivity: () => null,
}));

import { ScheduledTasksPanel } from "./ScheduledTasksPanel";

function task(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    cron_id: "cron-1",
    name: "Daily",
    prompt: "Brief me",
    schedule: "0 9 * * *",
    timezone: "Asia/Shanghai",
    next_run_date: null,
    created_at: "2026-10-09T08:00:00+00:00",
    updated_at: "2026-10-09T08:00:00+00:00",
    ...overrides,
  };
}

// Captured before any spy, so a second stub in one test still reaches it.
const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

function stubBrowserTimeZone(timeZone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(
    function (this: Intl.DateTimeFormat) {
      return {
        ...realResolvedOptions.call(this),
        timeZone,
      } as Intl.ResolvedDateTimeFormatOptions;
    }
  );
}

function openEdit(name: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
  fireEvent.click(
    screen.getByRole("button", { name: `Edit scheduled task "${name}"` })
  );
}

const saveButton = () => screen.getByRole("button", { name: /Save changes/ });

beforeEach(() => {
  stubBrowserTimeZone("Asia/Shanghai");
  hook.tasks = [];
  hook.updateScheduledTask.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("ScheduledTasksPanel time zones", () => {
  it("shows the time zone each task runs in", () => {
    hook.tasks = [
      task({ cron_id: "a", name: "London", timezone: "Europe/London" }),
      task({ cron_id: "b", name: "Legacy", timezone: null }),
    ];
    render(<ScheduledTasksPanel />);

    expect(screen.getByText("Every day at 09:00 · Europe/London")).toBeTruthy();
    expect(screen.getByText("Every day at 09:00 · UTC")).toBeTruthy();
  });

  it("previews a new task in the browser's time zone", () => {
    render(<ScheduledTasksPanel />);
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));

    expect(screen.getByText("Every day at 09:00 · Asia/Shanghai")).toBeTruthy();
  });

  it("explains the switch when editing a UTC task and saves it unchanged", async () => {
    const legacy = task({ cron_id: "legacy", name: "Legacy", timezone: null });
    hook.tasks = [legacy];
    hook.updateScheduledTask.mockResolvedValue({
      task: { ...legacy, cron_id: "new", timezone: "Asia/Shanghai" },
      oldTaskDeleted: true,
    });
    render(<ScheduledTasksPanel />);
    openEdit("Legacy");

    expect(
      screen.getByText(
        "This task has no time zone and runs on UTC time. Saving it switches it to Asia/Shanghai time."
      )
    ).toBeTruthy();
    expect(saveButton().hasAttribute("disabled")).toBe(false);

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith({
        cronId: "legacy",
        name: "Legacy",
        prompt: "Brief me",
        schedule: "0 9 * * *",
        timezone: null,
      })
    );
  });

  it("keeps the time zone of a task made in another one", async () => {
    const london = task({ name: "London", timezone: "Europe/London" });
    hook.tasks = [london];
    hook.updateScheduledTask.mockResolvedValue({
      task: london,
      oldTaskDeleted: true,
    });
    render(<ScheduledTasksPanel />);
    openEdit("London");

    expect(screen.queryByText(/Saving it switches it/)).toBeNull();
    expect(
      screen.getAllByText("Every day at 09:00 · Europe/London").length
    ).toBeGreaterThan(1);
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Task name"), {
      target: { value: "London briefing" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "London briefing",
          timezone: "Europe/London",
        })
      )
    );
  });

  it("needs a change before saving a task already in the browser's time zone", () => {
    hook.tasks = [task({ name: "Local" })];
    render(<ScheduledTasksPanel />);
    openEdit("Local");

    expect(screen.queryByText(/Saving it switches it/)).toBeNull();
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });
});
