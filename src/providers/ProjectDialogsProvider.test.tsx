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
  assistants: { search: vi.fn() },
  threads: { search: vi.fn() },
  crons: { search: vi.fn(), update: vi.fn() },
  runs: { list: vi.fn(async () => []), cancel: vi.fn() },
}));

vi.mock("@/app/hooks/useSettings", () => ({
  useSettingsAccess: () => ({ access: access.value, refresh: vi.fn() }),
}));
vi.mock("@/providers/ClientProvider", () => ({ useClient: () => client }));
vi.mock("sonner", () => ({
  toast: Object.assign(
    vi.fn(() => "move-toast"),
    { success: vi.fn(), warning: vi.fn(), error: vi.fn() }
  ),
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

function renderDialogs(
  projects = mockProjects(readyProjects(A), { current: A })
) {
  const tree = (value: typeof projects) => (
    <TestProjectsProvider value={value}>
      <ProjectDialogsProvider>
        <Probe />
      </ProjectDialogsProvider>
    </TestProjectsProvider>
  );
  const { rerender } = render(tree(projects));
  return {
    projects,
    /** Show another project list, as a refresh does. */
    showProjects: (value: typeof projects) => rerender(tree(value)),
  };
}

/** The confirm button once the project's work is read: it shows earlier,
 *  disabled, with the same label. */
async function removeButton() {
  const button = await screen.findByRole("button", {
    name: "Remove project",
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
  client.assistants.search.mockResolvedValue(
    ["EvoScientist", "scheduler"].map((graph) => ({
      assistant_id: workspaceAssistantId(graph, A),
    }))
  );
  client.threads.search.mockResolvedValue([]);
  client.crons.search.mockResolvedValue([]);
  client.crons.update.mockResolvedValue({});
  client.runs.list.mockResolvedValue([]);
  client.runs.cancel.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast).mockClear();
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

describe("Move project", () => {
  const GONE = { key: "/old/data/projB", name: "projB", missing: true };
  const OTHER_GONE = { key: "/old/notes", name: "notes", missing: true };

  function renderWithMissing(canMove = true) {
    return renderDialogs(
      mockProjects(readyProjects(A, OTHER_GONE, GONE), {
        current: A,
        canMove,
      })
    );
  }

  const moved = {
    workspace_dir: "/srv/projB",
    threads: 2,
    tasks: 1,
    memory: ["P-0123456789abcdef"],
    proposals: 0,
    warnings: [],
    resumed: false,
    moved: true,
  };

  function typeFolder(path: string) {
    fireEvent.change(screen.getByLabelText("Folder"), {
      target: { value: path },
    });
  }

  it("offers the missing projects when adding, a new project by default", () => {
    renderWithMissing();
    act(() => dialogs!.openAddProject());
    typeFolder("/srv/projB");

    const choices = screen.getAllByRole("radio");
    expect(choices).toHaveLength(3);
    expect((choices[0] as HTMLInputElement).checked).toBe(true);
    expect(choices[0].closest("label")!.textContent).toMatch(/new project/);
    // The project named like the folder comes first, marked.
    expect(choices[1].closest("label")!.textContent).toContain(GONE.key);
    expect(choices[1].closest("label")!.textContent).toMatch(/same name/);
    expect(choices[2].closest("label")!.textContent).not.toMatch(/same name/);
  });

  it("adds the folder when no missing project is chosen", async () => {
    const fetchMock = stubRelay(200, { workspace_dir: "/srv/projB" });
    renderWithMissing();
    act(() => dialogs!.openAddProject());
    typeFolder("/srv/projB");

    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith("/api/projects", expect.anything());
  });

  it("moves the chosen project instead of adding, and switches to its new folder", async () => {
    const fetchMock = stubRelay(200, moved);
    const { projects } = renderWithMissing();
    act(() => dialogs!.openAddProject());
    typeFolder("/srv/projB");

    fireEvent.click(screen.getByRole("radio", { name: /projB/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(url).toBe("/api/projects/move");
    expect(JSON.parse(String(init.body))).toEqual({
      old: GONE.key,
      new: "/srv/projB",
    });
    expect(projects.followMove).toHaveBeenCalledWith(GONE.key, "/srv/projB");
    expect(projects.refresh).toHaveBeenCalled();
    expect(vi.mocked(toast.success).mock.calls[0][0]).toContain(
      "2 conversations, 1 scheduled task, its memory"
    );
  });

  it("keeps the chosen project when a refresh drops it before a retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "backend_timeout" }), {
          status: 504,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...moved, resumed: true }), {
          status: 200,
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { showProjects } = renderWithMissing();
    act(() => dialogs!.openAddProject());
    typeFolder("/srv/projB");
    fireEvent.click(screen.getByRole("radio", { name: /projB/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await screen.findByRole("alert");

    // The move finished meanwhile: the list no longer has the old folder.
    showProjects(
      mockProjects(readyProjects(A, "/srv/projB"), {
        current: A,
        canMove: true,
      })
    );
    expect(
      (screen.getByRole("radio", { name: /projB/ }) as HTMLInputElement).checked
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [url, init] = fetchMock.mock.lastCall as unknown as [
      string,
      RequestInit
    ];
    expect(url).toBe("/api/projects/move");
    expect(JSON.parse(String(init.body))).toEqual({
      old: GONE.key,
      new: "/srv/projB",
    });
  });

  it("says a move onto a registered project merges into it, and still moves", async () => {
    const fetchMock = stubRelay(200, { ...moved, workspace_dir: A });
    renderWithMissing();
    act(() => dialogs!.openMoveProject!(GONE));

    typeFolder("/srv/other");
    expect(screen.queryByText(/merged into/)).toBeNull();
    typeFolder(`${A}/`);
    expect(screen.getByText(/merged into/).textContent).toContain("projA");

    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/move",
      expect.anything()
    );
  });

  describe("which typed folder merges into a registered project", () => {
    function mergeNotice(registered: string, typed: string) {
      renderDialogs(
        mockProjects(readyProjects(registered, GONE), {
          current: registered,
          canMove: true,
        })
      );
      act(() => dialogs!.openMoveProject!(GONE));
      typeFolder(typed);
      return screen.queryByText(/merged into/);
    }

    it.each([
      ["a trailing separator", "/data/proj", "/data/proj/"],
      ["repeated separators", "/data/proj", "/data//proj"],
      ["the kind of separator", "C:\\Data\\Proj", "C:/Data/Proj"],
      ["case in a Windows path", "C:\\Data\\Proj", "c:/data/proj/"],
      ["case in a UNC path", "\\\\srv\\Share\\Proj", "\\\\srv\\share\\proj"],
    ])("ignores %s", (_label, registered, typed) => {
      expect(mergeNotice(registered, typed)).not.toBeNull();
    });

    it("tells apart POSIX paths that differ in case", () => {
      expect(mergeNotice("/data/Proj", "/data/proj")).toBeNull();
    });
  });

  it("says a move chosen when adding merges into a registered project", () => {
    renderWithMissing();
    act(() => dialogs!.openAddProject());
    typeFolder(A);
    expect(screen.queryByText(/merged into/)).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /projB/ }));

    expect(screen.getByText(/merged into/)).toBeTruthy();
  });

  it("marks a project of the same name in another case", () => {
    renderWithMissing();
    act(() => dialogs!.openAddProject());
    typeFolder("/srv/PROJB");

    expect(
      screen.getAllByRole("radio")[1].closest("label")!.textContent
    ).toMatch(/same name/);
  });

  it("offers no choice when the backend can't move projects", () => {
    renderWithMissing(false);
    act(() => dialogs!.openAddProject());

    expect(screen.queryByRole("radio")).toBeNull();
    expect(dialogs!.openMoveProject).toBeUndefined();
  });

  it("offers no move on a page that can't change projects", () => {
    access.value = { writable: false, reason: "other_backend" };
    renderWithMissing();

    expect(dialogs!.openMoveProject).toBeUndefined();
  });

  it("moves a missing project to the folder typed for it", async () => {
    const fetchMock = stubRelay(200, moved);
    renderWithMissing();
    act(() => dialogs!.openMoveProject!(GONE));

    expect(screen.queryByRole("radio")).toBeNull();
    typeFolder("/srv/projB");
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/move",
      expect.anything()
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it("keeps the dialog open with the reason when the move fails", async () => {
    stubRelay(500, {
      error: "move_failed",
      detail: "disk full",
      pending: true,
    });
    const { projects } = renderWithMissing();
    act(() => dialogs!.openMoveProject!(GONE));
    typeFolder("/srv/projB");

    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("disk full");
    expect(alert.textContent).toMatch(/try again/i);
    expect(projects.followMove).not.toHaveBeenCalled();
  });

  it("warns, without a success, when nothing was moved", async () => {
    stubRelay(200, {
      ...moved,
      workspace_dir: GONE.key,
      warnings: ["The old folder is back: nothing was moved."],
      moved: false,
    });
    const { projects } = renderWithMissing();
    act(() => dialogs!.openMoveProject!(GONE));
    typeFolder("/srv/projB");

    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.warning).toHaveBeenCalledWith(
      "The old folder is back: nothing was moved.",
      expect.anything()
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(projects.followMove).not.toHaveBeenCalled();
  });

  /** The relay answers once the returned function is called. */
  function stubSlowRelay() {
    let answer: (status: number, body: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = (status, body) =>
              resolve(new Response(JSON.stringify(body), { status }));
          })
      )
    );
    return (status: number, body: unknown) => answer(status, body);
  }

  describe("closed while the move runs", () => {
    async function startAndClose(folder = "/srv/projB") {
      const answer = stubSlowRelay();
      const rendered = renderWithMissing();
      act(() => dialogs!.openMoveProject!(GONE));
      typeFolder(folder);
      fireEvent.click(screen.getByRole("button", { name: "Move" }));
      await screen.findByText(/Moving projB's/);

      // The footer's button, not the dialog's corner one: it closes, the
      // move goes on.
      const close = screen
        .getAllByRole("button", { name: "Close" })
        .find((button) => button.querySelector(".sr-only") === null)!;
      fireEvent.click(close);

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      // A plain toast, which can be closed, until the move ends.
      expect(toast).toHaveBeenCalledWith(expect.stringContaining("projB"), {
        duration: Infinity,
      });
      return { answer, ...rendered };
    }

    /** The duration an outcome toast ends up with: sonner merges its
     *  options over the moving toast's. */
    const durationOver = (options: unknown) =>
      ({ duration: Infinity, ...(options as object) }.duration);

    it("turns the moving toast into the success, which then goes away", async () => {
      const { answer, projects } = await startAndClose();

      await act(async () => answer(200, moved));

      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("2 conversations"),
        expect.objectContaining({ id: "move-toast" })
      );
      expect(durationOver(vi.mocked(toast.success).mock.calls[0][1])).not.toBe(
        Infinity
      );
      expect(projects.followMove).toHaveBeenCalledWith(GONE.key, "/srv/projB");
      expect(projects.refresh).toHaveBeenCalled();
    });

    it("turns the moving toast into the failure, naming the folder sent", async () => {
      const { answer } = await startAndClose('  "/srv/projB"  ');

      await act(async () =>
        answer(409, { error: "busy", detail: "A conversation is running." })
      );

      expect(toast.error).toHaveBeenCalledWith(
        "A conversation is running.",
        expect.objectContaining({
          id: "move-toast",
          description: "projB → /srv/projB",
        })
      );
      expect(durationOver(vi.mocked(toast.error).mock.calls[0][1])).toBe(
        15_000
      );
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("offers no other move of the project until its move fails", async () => {
      const { answer } = await startAndClose();
      expect(dialogs!.moving?.has(GONE.key)).toBe(true);

      await act(async () =>
        answer(409, { error: "busy", detail: "A conversation is running." })
      );

      expect(dialogs!.moving?.has(GONE.key)).toBe(false);
    });

    it("offers no other move of a moved project until the list is read again", async () => {
      const { answer, projects } = await startAndClose();
      let listRead: () => void = () => {};
      vi.mocked(projects.refresh).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            listRead = () => resolve(projects.projects);
          })
      );

      await act(async () => answer(200, moved));
      expect(dialogs!.moving?.has(GONE.key)).toBe(true);

      await act(async () => listRead());
      expect(dialogs!.moving?.has(GONE.key)).toBe(false);
    });

    it("keeps showing the dialog's own choice while it is being moved", async () => {
      stubSlowRelay();
      renderWithMissing();
      act(() => dialogs!.openAddProject());
      typeFolder("/srv/projB");
      fireEvent.click(screen.getByRole("radio", { name: /projB/ }));
      fireEvent.click(screen.getByRole("button", { name: "Move" }));
      await screen.findByText(/Moving projB's/);

      expect(dialogs!.moving?.has(GONE.key)).toBe(true);
      expect(
        (screen.getByRole("radio", { name: /projB/ }) as HTMLInputElement)
          .checked
      ).toBe(true);
    });

    it("doesn't offer a project being moved when adding a folder", async () => {
      await startAndClose();

      act(() => dialogs!.openAddProject());
      typeFolder("/srv/projB");

      const choices = screen.getAllByRole("radio");
      expect(
        choices.map((choice) => choice.closest("label")!.textContent)
      ).toEqual([
        expect.stringMatching(/new project/),
        expect.stringContaining(OTHER_GONE.key),
      ]);
    });

    it("turns the moving toast into the first warning when nothing moved", async () => {
      const { answer } = await startAndClose();

      await act(async () =>
        answer(200, {
          ...moved,
          workspace_dir: GONE.key,
          warnings: ["The old folder is back.", "Another note."],
          moved: false,
        })
      );

      const calls = vi.mocked(toast.warning).mock.calls;
      expect(calls.map(([text]) => text)).toEqual([
        "The old folder is back.",
        "Another note.",
      ]);
      expect(calls[0][1]).toMatchObject({ id: "move-toast" });
      expect(durationOver(calls[0][1])).toBe(15_000);
      expect(calls[1][1]).not.toHaveProperty("id");
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  it("can't be closed while a project is being added", async () => {
    stubSlowRelay();
    renderWithMissing();
    act(() => dialogs!.openAddProject());
    typeFolder("/srv/new");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText(/Adding the project/);

    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("Remove project", () => {
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

  it("lists the tasks on the assistants it knows when the backend's list can't be read", async () => {
    client.assistants.search.mockRejectedValue(new Error("network"));
    client.crons.search.mockResolvedValue([
      {
        cron_id: "task-1",
        assistant_id: workspaceAssistantId("scheduler", A),
        enabled: true,
        metadata: { run_kind: "scheduled_task", name: "Daily" },
      },
    ]);
    renderDialogs();
    act(() =>
      dialogs!.openRemoveProject({ key: A, name: "projA", missing: false })
    );

    expect(await screen.findByText("Daily")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Pause 1 task and remove" })
    ).toBeTruthy();
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
        name: "Remove project",
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
