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
  setScheduledTaskEnabled: vi.fn(),
}));

vi.mock("@/app/hooks/useScheduledTasks", async (importOriginal) => {
  const { useState } = await import("react");
  return {
    ...(await importOriginal<typeof import("@/app/hooks/useScheduledTasks")>()),
    useScheduledTasks: () => {
      const [tasks, setTasks] = useState(hook.tasks);
      return {
        tasks,
        loading: false,
        error: null,
        refresh: vi.fn(),
        replaceTask: (task: ScheduledTask) =>
          setTasks((current) =>
            current.map((t) => (t.cron_id === task.cron_id ? task : t))
          ),
      };
    },
    updateScheduledTask: hook.updateScheduledTask,
    setScheduledTaskEnabled: hook.setScheduledTaskEnabled,
    useServedFolder: () => "/home/you/projA",
    useAssistantRecovery: () => () => {},
    useSchedulerGate: () => () => true,
    useSchedulerTarget: () => ({
      assistantId: "scheduler-assistant",
      workspaceDir: "/home/you/projA",
    }),
  };
});

vi.mock("@/app/components/ScheduledTaskActivity", () => ({
  ScheduledTaskActivity: () => null,
}));

import { ScheduledTasksPanel } from "./ScheduledTasksPanel";

// jsdom has no scrollIntoView; Radix Select calls it on the item it focuses
// when a list opens.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

/** Picks from one of the builder's in-page lists (Radix Select): open it,
 *  then choose the option by its name. */
function pick(list: string, option: string) {
  fireEvent.click(screen.getByLabelText(list));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

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
    workspaceDir: null,
    enabled: true,
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
const customCron = () =>
  (screen.getByPlaceholderText("0 9 * * 1-5") as HTMLInputElement).value;

beforeEach(() => {
  stubBrowserTimeZone("Asia/Shanghai");
  hook.tasks = [];
  hook.updateScheduledTask.mockReset();
  hook.setScheduledTaskEnabled.mockReset();
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
      ...legacy,
      cron_id: "new",
      timezone: "Asia/Shanghai",
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
    hook.updateScheduledTask.mockResolvedValue(london);
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

  it("lets a task of another folder be edited in place but not run here", () => {
    hook.tasks = [task({ name: "Elsewhere", workspaceDir: "/home/you/projB" })];
    render(<ScheduledTasksPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Elsewhere/ }));

    expect(
      screen
        .getByRole("button", { name: 'Edit scheduled task "Elsewhere"' })
        .hasAttribute("disabled")
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: /Run now/ }).hasAttribute("disabled")
    ).toBe(true);
  });
});

describe("ScheduledTasksPanel pause and resume", () => {
  it("pauses a task and shows it as paused", async () => {
    const daily = task({
      name: "Briefing",
      next_run_date: "2026-10-10T01:00:00+00:00",
    });
    hook.tasks = [daily];
    hook.setScheduledTaskEnabled.mockResolvedValue({
      ...daily,
      enabled: false,
    });
    render(<ScheduledTasksPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Briefing/ }));
    fireEvent.click(
      screen.getByRole("button", { name: 'Pause scheduled task "Briefing"' })
    );

    await waitFor(() =>
      expect(hook.setScheduledTaskEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ cron_id: "cron-1" }),
        false
      )
    );
    expect(
      await screen.findByRole("button", {
        name: 'Resume scheduled task "Briefing"',
      })
    ).toBeTruthy();
  });

  it("resumes a paused task", async () => {
    const paused = task({ name: "Briefing", enabled: false });
    hook.tasks = [paused];
    hook.setScheduledTaskEnabled.mockResolvedValue({
      ...paused,
      enabled: true,
    });
    render(<ScheduledTasksPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Briefing/ }));
    fireEvent.click(
      screen.getByRole("button", { name: 'Resume scheduled task "Briefing"' })
    );

    await waitFor(() =>
      expect(hook.setScheduledTaskEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ cron_id: "cron-1" }),
        true
      )
    );
  });

  it("keeps the pane on the task the user moved to when a pause returns late", async () => {
    hook.tasks = [
      task({ cron_id: "a", name: "Alpha" }),
      task({ cron_id: "b", name: "Beta" }),
    ];
    let finish: (value: ScheduledTask) => void = () => {};
    hook.setScheduledTaskEnabled.mockReturnValue(
      new Promise<ScheduledTask>((resolve) => (finish = resolve))
    );
    render(<ScheduledTasksPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    fireEvent.click(
      screen.getByRole("button", { name: 'Pause scheduled task "Alpha"' })
    );
    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));

    finish(task({ cron_id: "a", name: "Alpha", enabled: false }));

    expect(await screen.findByText("Paused")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Beta" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: 'Pause scheduled task "Beta"' })
        .hasAttribute("disabled")
    ).toBe(false);
  });

  it("lists a paused task as paused, not by its next run", () => {
    hook.tasks = [
      task({
        name: "Briefing",
        enabled: false,
        next_run_date: "2026-10-10T01:00:00+00:00",
      }),
    ];
    render(<ScheduledTasksPanel />);

    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.queryByText(/^Next:/)).toBeNull();
  });
});

describe("ScheduledTasksPanel custom cron", () => {
  it("keeps a weekday range when a task is saved without touching its schedule", async () => {
    const weekdays = task({ name: "Weekdays", schedule: "0 9 * * 1-5" });
    hook.tasks = [weekdays];
    hook.updateScheduledTask.mockResolvedValue({
      ...weekdays,
      name: "Weekday briefing",
    });
    render(<ScheduledTasksPanel />);
    // The list shows the expression, not "Every Mon at 09:00".
    expect(
      screen.getAllByText("0 9 * * 1-5 · Asia/Shanghai").length
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Every Mon at 09:00 · Asia/Shanghai")).toBeNull();
    openEdit("Weekdays");

    fireEvent.change(screen.getByLabelText("Task name"), {
      target: { value: "Weekday briefing" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Weekday briefing",
          schedule: "0 9 * * 1-5",
        })
      )
    );
  });

  // The same in-page list as the Settings page's, not the system's popup.
  it("picks the frequency and the day from in-page lists", () => {
    render(<ScheduledTasksPanel />);
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    const frequency = screen.getByLabelText("Schedule frequency");
    expect(frequency.tagName).toBe("BUTTON");
    expect(frequency.textContent).toBe("Every day");

    pick("Schedule frequency", "Every month");
    expect(frequency.textContent).toBe("Every month");
    pick("Day of month", "Day 15");
    expect(screen.getByLabelText("Day of month").textContent).toBe("Day 15");
    expect(screen.getByText(/^Monthly on day 15 at 09:00/)).toBeTruthy();

    pick("Schedule frequency", "Every week");
    pick("Day of week", "Fri");
    expect(screen.getByLabelText("Day of week").textContent).toBe("Fri");
    expect(screen.getByText(/^Every Fri at 09:00/)).toBeTruthy();
  });

  it("starts the builder from a custom cron's time when switched to weekly", () => {
    hook.tasks = [task({ name: "Afternoons", schedule: "30 14 * * 1-5" })];
    render(<ScheduledTasksPanel />);
    openEdit("Afternoons");

    pick("Schedule frequency", "Every week");
    expect(screen.getByText("Every Mon at 14:30 · Asia/Shanghai")).toBeTruthy();
  });

  it("keeps a stored schedule's own spelling while the schedule is unchanged", async () => {
    const zeros = task({ name: "Zeros", schedule: "09 07 * * *" });
    hook.tasks = [zeros];
    hook.updateScheduledTask.mockResolvedValue({
      ...zeros,
      name: "Zeros renamed",
    });
    render(<ScheduledTasksPanel />);
    openEdit("Zeros");

    // Read as the builder's daily schedule, with nothing to save yet.
    expect(
      screen.getAllByText("Every day at 07:09 · Asia/Shanghai").length
    ).toBeGreaterThan(1);
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Task name"), {
      target: { value: "Zeros renamed" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Zeros renamed",
          schedule: "09 07 * * *",
        })
      )
    );
  });

  it("shows a task's own cron when switched to Custom cron", () => {
    hook.tasks = [task({ name: "Nines", schedule: "00 09 * * *" })];
    render(<ScheduledTasksPanel />);
    openEdit("Nines");

    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("00 09 * * *");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("keeps the stored spelling after a visit to Custom cron", async () => {
    const zeros = task({ name: "Zeros", schedule: "09 07 * * *" });
    hook.tasks = [zeros];
    hook.updateScheduledTask.mockResolvedValue({
      ...zeros,
      name: "Zeros renamed",
    });
    render(<ScheduledTasksPanel />);
    openEdit("Zeros");
    pick("Schedule frequency", "Custom cron");
    pick("Schedule frequency", "Every day");
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Task name"), {
      target: { value: "Zeros renamed" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({ schedule: "09 07 * * *" })
      )
    );
  });

  it("saves a task's own cron from Custom cron", async () => {
    const zeros = task({ name: "Zeros", schedule: "09 07 * * *" });
    hook.tasks = [zeros];
    hook.updateScheduledTask.mockResolvedValue({
      ...zeros,
      name: "Zeros renamed",
    });
    render(<ScheduledTasksPanel />);
    openEdit("Zeros");

    pick("Schedule frequency", "Custom cron");
    fireEvent.change(screen.getByLabelText("Task name"), {
      target: { value: "Zeros renamed" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({ schedule: "09 07 * * *" })
      )
    );
  });

  it("keeps a UTC task's cron when it is saved from Custom cron", async () => {
    const legacy = task({
      name: "Legacy",
      schedule: "09 07 * * *",
      timezone: null,
    });
    hook.tasks = [legacy];
    hook.updateScheduledTask.mockResolvedValue(legacy);
    render(<ScheduledTasksPanel />);
    openEdit("Legacy");

    pick("Schedule frequency", "Custom cron");
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({ schedule: "09 07 * * *" })
      )
    );
  });

  it("starts Custom cron from a schedule changed in the builder", async () => {
    const zeros = task({ name: "Zeros", schedule: "09 07 * * *" });
    hook.tasks = [zeros];
    hook.updateScheduledTask.mockResolvedValue(zeros);
    render(<ScheduledTasksPanel />);
    openEdit("Zeros");

    fireEvent.change(screen.getByLabelText("Hour"), { target: { value: "8" } });
    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("9 8 * * *");
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({ schedule: "9 8 * * *" })
      )
    );
  });

  it("returns to a task's own cron when a builder change is undone", () => {
    hook.tasks = [task({ name: "Zeros", schedule: "09 07 * * *" })];
    render(<ScheduledTasksPanel />);
    openEdit("Zeros");
    fireEvent.change(screen.getByLabelText("Hour"), { target: { value: "8" } });
    pick("Schedule frequency", "Custom cron");
    pick("Schedule frequency", "Every day");
    fireEvent.change(screen.getByLabelText("Hour"), { target: { value: "7" } });
    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("09 07 * * *");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("keeps a custom cron's text after a look at the builder", () => {
    hook.tasks = [task({ name: "Afternoons", schedule: "30 14 * * 1-5" })];
    render(<ScheduledTasksPanel />);
    openEdit("Afternoons");
    pick("Schedule frequency", "Every week");
    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("30 14 * * 1-5");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("starts Custom cron from a template changed in the builder", () => {
    render(<ScheduledTasksPanel />);
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Weekly Research Review/ })
    );

    pick("Day of week", "Mon");
    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("0 17 * * 1");
  });

  it("fills Custom cron again once the builder is back at the schedule", () => {
    hook.tasks = [task({ name: "Zeros", schedule: "09 07 * * *" })];
    render(<ScheduledTasksPanel />);
    openEdit("Zeros");
    pick("Schedule frequency", "Every week");
    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("9 7 * * 1");
    pick("Schedule frequency", "Every day");
    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("09 07 * * *");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("fills a new task's Custom cron from the builder each time", () => {
    render(<ScheduledTasksPanel />);
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    pick("Schedule frequency", "Every week");
    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("0 9 * * 1");
    pick("Schedule frequency", "Every day");
    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("0 9 * * *");
  });

  it("keeps a custom cron's text through more than one frequency", () => {
    hook.tasks = [task({ name: "Afternoons", schedule: "30 14 * * 1-5" })];
    render(<ScheduledTasksPanel />);
    openEdit("Afternoons");
    pick("Schedule frequency", "Every week");
    pick("Schedule frequency", "Every day");
    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("30 14 * * 1-5");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("keeps text typed in Custom cron through the builder", () => {
    hook.tasks = [task({ name: "Zeros", schedule: "09 07 * * *" })];
    render(<ScheduledTasksPanel />);
    openEdit("Zeros");
    pick("Schedule frequency", "Custom cron");
    fireEvent.change(screen.getByPlaceholderText("0 9 * * 1-5"), {
      target: { value: "*/5 * * * *" },
    });
    pick("Schedule frequency", "Every week");
    pick("Schedule frequency", "Every day");
    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("*/5 * * * *");
  });

  it("fills an emptied Custom cron box again", () => {
    hook.tasks = [task({ name: "Zeros", schedule: "09 07 * * *" })];
    render(<ScheduledTasksPanel />);
    openEdit("Zeros");
    pick("Schedule frequency", "Custom cron");
    fireEvent.change(screen.getByPlaceholderText("0 9 * * 1-5"), {
      target: { value: "   " },
    });
    pick("Schedule frequency", "Every day");
    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("09 07 * * *");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("keeps a custom cron's text over a builder edit", () => {
    hook.tasks = [task({ name: "Weekdays", schedule: "0 9 * * 1-5" })];
    render(<ScheduledTasksPanel />);
    openEdit("Weekdays");

    // The box keeps what the builder cannot show; the edit is still there on
    // Every day.
    pick("Schedule frequency", "Every day");
    fireEvent.change(screen.getByLabelText("Hour"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("Minute"), {
      target: { value: "30" },
    });
    pick("Schedule frequency", "Custom cron");
    expect(customCron()).toBe("0 9 * * 1-5");

    pick("Schedule frequency", "Every day");
    expect((screen.getByLabelText("Hour") as HTMLInputElement).value).toBe(
      "10"
    );
    expect((screen.getByLabelText("Minute") as HTMLInputElement).value).toBe(
      "30"
    );
  });

  it("saves a task stored as a shortcut such as @daily", async () => {
    const daily = task({ name: "Nightly", schedule: "@daily" });
    hook.tasks = [daily];
    hook.updateScheduledTask.mockResolvedValue({
      ...daily,
      name: "Nightly renamed",
    });
    render(<ScheduledTasksPanel />);
    openEdit("Nightly");

    expect(customCron()).toBe("@daily");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Task name"), {
      target: { value: "Nightly renamed" },
    });
    expect(saveButton().hasAttribute("disabled")).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({ schedule: "@daily" })
      )
    );
  });

  it("saves a stored cron the editor would not write, such as one with seconds", async () => {
    const secs = task({ name: "Seconds", schedule: "0 9 * * * 30" });
    hook.tasks = [secs];
    hook.updateScheduledTask.mockResolvedValue({
      ...secs,
      name: "Seconds renamed",
    });
    render(<ScheduledTasksPanel />);
    openEdit("Seconds");

    expect(customCron()).toBe("0 9 * * * 30");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Task name"), {
      target: { value: "Seconds renamed" },
    });
    expect(saveButton().hasAttribute("disabled")).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({ schedule: "0 9 * * * 30" })
      )
    );
  });

  it("still checks a cron typed in Custom cron", () => {
    hook.tasks = [task({ name: "Eight", schedule: "0 8 * * *" })];
    render(<ScheduledTasksPanel />);
    openEdit("Eight");

    pick("Schedule frequency", "Custom cron");
    fireEvent.change(screen.getByPlaceholderText("0 9 * * 1-5"), {
      target: { value: "0 9 * * * 30" },
    });
    expect(
      screen.getByText("Use minute hour day month weekday, or @daily.")
    ).toBeTruthy();
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("starts the builder at the time a shortcut stands for", () => {
    hook.tasks = [task({ name: "Nightly", schedule: "@daily" })];
    render(<ScheduledTasksPanel />);
    openEdit("Nightly");

    pick("Schedule frequency", "Every day");
    expect((screen.getByLabelText("Hour") as HTMLInputElement).value).toBe("0");
    expect(screen.getByText("Every day at 00:00 · Asia/Shanghai")).toBeTruthy();
  });

  it("keeps the hour and minute whole numbers", async () => {
    const eight = task({ name: "Eight", schedule: "0 8 * * *" });
    hook.tasks = [eight];
    hook.updateScheduledTask.mockResolvedValue(eight);
    render(<ScheduledTasksPanel />);
    openEdit("Eight");

    const hour = screen.getByLabelText("Hour") as HTMLInputElement;
    const minute = screen.getByLabelText("Minute") as HTMLInputElement;
    fireEvent.change(hour, { target: { value: "9.5" } });
    fireEvent.change(minute, { target: { value: "30.7" } });
    expect([hour.value, minute.value]).toEqual(["9", "30"]);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({ schedule: "30 9 * * *" })
      )
    );
  });

  it("saves a custom cron typed in the builder's spelling", async () => {
    const zeros = task({ name: "Zeros", schedule: "09 07 * * *" });
    hook.tasks = [zeros];
    hook.updateScheduledTask.mockResolvedValue({
      ...zeros,
      schedule: "9 7 * * *",
    });
    render(<ScheduledTasksPanel />);
    openEdit("Zeros");

    // Typed in Custom cron, the builder's spelling is an edit like any other.
    pick("Schedule frequency", "Custom cron");
    fireEvent.change(screen.getByPlaceholderText("0 9 * * 1-5"), {
      target: { value: "9 7 * * *" },
    });
    expect(saveButton().hasAttribute("disabled")).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({ schedule: "9 7 * * *" })
      )
    );
  });

  it("writes the builder's spelling once the schedule changes", async () => {
    const zeros = task({ name: "Zeros", schedule: "09 07 * * *" });
    hook.tasks = [zeros];
    hook.updateScheduledTask.mockResolvedValue(zeros);
    render(<ScheduledTasksPanel />);
    openEdit("Zeros");

    fireEvent.change(screen.getByLabelText("Hour"), { target: { value: "8" } });
    expect(saveButton().hasAttribute("disabled")).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(hook.updateScheduledTask).toHaveBeenCalledWith(
        expect.objectContaining({ schedule: "9 8 * * *" })
      )
    );
  });
});
