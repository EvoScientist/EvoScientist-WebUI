// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";

const access = vi.hoisted(() => ({
  value: { writable: true } as unknown,
}));
const client = vi.hoisted(() => ({
  threads: { search: vi.fn() },
  crons: { search: vi.fn(), update: vi.fn() },
  runs: { list: vi.fn(async () => []), cancel: vi.fn() },
}));

vi.mock("@/app/hooks/useSettings", () => ({
  useSettingsAccess: () => ({ access: access.value, refresh: vi.fn() }),
}));
vi.mock("@/providers/ClientProvider", () => ({ useClient: () => client }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { ProjectDialogsProvider } from "./ProjectDialogsProvider";
import {
  useProjectDialogs,
  type ProjectDialogsValue,
} from "./projectDialogsContext";
import {
  TestProjectsProvider,
  mockProjects,
  readyProjects,
} from "@/test/mockProjects";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";

const A = "/home/you/projA";

let dialogs: ProjectDialogsValue | null = null;
function Probe() {
  dialogs = useProjectDialogs();
  return null;
}

function renderDialogs() {
  const projects = mockProjects(readyProjects(A), { current: A });
  render(
    <TestProjectsProvider value={projects}>
      <ProjectDialogsProvider>
        <Probe />
      </ProjectDialogsProvider>
    </TestProjectsProvider>
  );
  return { projects };
}

/** The confirm button once the project's work is read: it shows earlier,
 *  disabled, with the same label. */
async function removeButton() {
  const button = await screen.findByRole("button", {
    name: "Remove from sidebar",
  });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  return button;
}

async function removed() {
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(toast.success).toHaveBeenCalled();
}

function stubRelay(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify(body), { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  access.value = { writable: true };
  client.threads.search.mockResolvedValue([]);
  client.crons.search.mockResolvedValue([]);
  client.crons.update.mockResolvedValue({});
  client.runs.list.mockResolvedValue([]);
  client.runs.cancel.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe("Add project", () => {
  it("adds the folder and closes, leaving the current project as it is", async () => {
    stubRelay(200, {
      workspace_dir: "/srv/projB",
      host: "0.0.0.0",
      tunnel: false,
    });
    const { projects } = renderDialogs();
    act(() => dialogs!.openAddProject());

    fireEvent.change(screen.getByLabelText("Folder"), {
      target: { value: "/srv/projB" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(projects.refresh).toHaveBeenCalled();
    expect(projects.selectProject).not.toHaveBeenCalled();
    // The backend listens on the network: say so.
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining("0.0.0.0"),
      expect.anything()
    );
  });

  it("keeps the dialog open with the reason when the folder is refused", async () => {
    stubRelay(400, { error: "folder_missing" });
    const { projects } = renderDialogs();
    act(() => dialogs!.openAddProject("/nope"));

    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /never creates one/
    );
    expect(projects.selectProject).not.toHaveBeenCalled();
  });

  it("says why when this page can't change projects", () => {
    access.value = { writable: false, reason: "other_backend" };
    renderDialogs();
    act(() => dialogs!.openAddProject());

    expect(screen.getByText(/machine that runs it/)).toBeTruthy();
    expect(screen.queryByLabelText("Folder")).toBeNull();
  });
});

describe("Remove from sidebar", () => {
  it("lists what it stops and pauses, then removes", async () => {
    client.threads.search.mockResolvedValue([
      { thread_id: "t-1", metadata: { title: "Long run", workspace_dir: A } },
    ]);
    client.crons.search.mockResolvedValue([
      {
        cron_id: "task-1",
        assistant_id: workspaceAssistantId("scheduler", A),
        enabled: true,
        metadata: { run_kind: "scheduled_task", name: "Daily" },
      },
    ]);
    stubRelay(200, { workspace_dir: A });
    const { projects } = renderDialogs();
    act(() =>
      dialogs!.openRemoveProject({ key: A, name: "projA", missing: false })
    );

    expect(await screen.findByText("Long run")).toBeTruthy();
    expect(screen.getByText("Daily")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Stop 1 run, pause 1 task and remove",
      })
    );

    await removed();
    expect(projects.selectProject).not.toHaveBeenCalled();
    expect(client.crons.update).toHaveBeenCalledWith("task-1", {
      enabled: false,
    });
    expect(projects.refresh).toHaveBeenCalled();
  });

  it("removes a project with nothing running in one step", async () => {
    stubRelay(200, { workspace_dir: A });
    renderDialogs();
    act(() =>
      dialogs!.openRemoveProject({ key: A, name: "projA", missing: false })
    );

    fireEvent.click(await removeButton());

    await removed();
  });

  it("pauses the tasks the backend names on the next try", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "enabled_user_crons", cron_ids: ["hidden"] }),
          { status: 409 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workspace_dir: A }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);
    renderDialogs();
    act(() =>
      dialogs!.openRemoveProject({ key: A, name: "projA", missing: false })
    );

    fireEvent.click(await removeButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Pause them first/
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Pause 1 task and remove" })
    );

    await removed();
    expect(client.crons.update).toHaveBeenCalledWith("hidden", {
      enabled: false,
    });
  });

  describe("when a run can't be stopped after the removal", () => {
    async function removeWithStuckRun() {
      client.threads.search.mockResolvedValue([
        { thread_id: "t-1", metadata: { title: "Long run", workspace_dir: A } },
      ]);
      client.runs.list.mockResolvedValue([{ run_id: "run-1" }] as never);
      client.runs.cancel.mockRejectedValue(
        Object.assign(new Error("HTTP 500"), { status: 500 })
      );
      stubRelay(200, { workspace_dir: A });
      const { projects } = renderDialogs();
      act(() =>
        dialogs!.openRemoveProject({ key: A, name: "projA", missing: false })
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Stop 1 run and remove" })
      );
      await screen.findByRole("button", { name: "Stop them" });
      return { projects };
    }

    it("says the project is removed, lists the run and stops it on request", async () => {
      const { projects } = await removeWithStuckRun();

      expect(screen.getByRole("dialog").textContent).toMatch(/removed/);
      expect(screen.getByText("Long run")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
      expect(projects.refresh).toHaveBeenCalled();

      client.runs.cancel.mockResolvedValue(undefined);
      fireEvent.click(screen.getByRole("button", { name: "Stop them" }));

      await removed();
    });

    it("says when it couldn't check the runs, even with none listed", async () => {
      // Nothing was running when the dialog opened; reading again fails.
      stubRelay(200, { workspace_dir: A });
      renderDialogs();
      act(() =>
        dialogs!.openRemoveProject({ key: A, name: "projA", missing: false })
      );
      const remove = await screen.findByRole("button", {
        name: "Remove from sidebar",
      });
      await waitFor(() => expect(remove.hasAttribute("disabled")).toBe(false));
      client.threads.search.mockRejectedValue(new Error("network"));
      fireEvent.click(remove);

      expect(
        await screen.findByRole("button", { name: "Stop them" })
      ).toBeTruthy();
      expect(screen.getByRole("dialog").textContent).toMatch(
        /couldn't be checked/
      );

      client.threads.search.mockResolvedValue([]);
      fireEvent.click(screen.getByRole("button", { name: "Stop them" }));
      await removed();
    });

    it("says when it couldn't check the runs and a known one won't cancel", async () => {
      client.threads.search.mockResolvedValue([
        { thread_id: "t-1", metadata: { title: "Long run", workspace_dir: A } },
      ]);
      client.runs.list.mockResolvedValue([{ run_id: "run-1" }] as never);
      client.runs.cancel.mockRejectedValue(
        Object.assign(new Error("HTTP 500"), { status: 500 })
      );
      stubRelay(200, { workspace_dir: A });
      renderDialogs();
      act(() =>
        dialogs!.openRemoveProject({ key: A, name: "projA", missing: false })
      );
      const remove = await screen.findByRole("button", {
        name: "Stop 1 run and remove",
      });
      client.threads.search.mockRejectedValue(new Error("network"));
      fireEvent.click(remove);

      await screen.findByRole("button", { name: "Stop them" });
      expect(screen.getByRole("dialog").textContent).toMatch(
        /couldn't be checked, and these couldn't be cancelled/
      );
      expect(screen.getByText("Long run")).toBeTruthy();
    });

    it("keeps listing a run that still won't stop, and closes on request", async () => {
      await removeWithStuckRun();

      fireEvent.click(screen.getByRole("button", { name: "Stop them" }));
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Stop them" })
            .hasAttribute("disabled")
        ).toBe(false)
      );
      expect(screen.getByText("Long run")).toBeTruthy();
      expect(toast.warning).toHaveBeenCalled();

      // The footer's button, not the dialog's corner one.
      const close = screen
        .getAllByRole("button", { name: "Close" })
        .find((button) => button.querySelector(".sr-only") === null)!;
      fireEvent.click(close);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
  });
});
