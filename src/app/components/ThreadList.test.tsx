// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ThreadItem, ThreadScope } from "@/app/hooks/useThreads";
import {
  TEST_PROJECT,
  TestProjectsProvider,
  mockProjects,
  readyProjects,
} from "@/test/mockProjects";
import type { ProjectsContextValue } from "@/providers/ProjectsProvider";

const OTHER = "/srv/projB";

vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: () => react.useState<string | null>(null),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("@/app/hooks/useSettings", () => ({
  useSettings: () => ({ payload: undefined }),
}));

vi.mock("@/app/hooks/useMemoryActivity", () => ({
  useMemoryActivity: () => ({ unseenCount: 0, markSeen: vi.fn() }),
}));

const threadFixtures: ThreadItem[] = [
  {
    id: "t-1",
    updatedAt: new Date(),
    status: "idle",
    title: "Protein folding survey",
    description: "latest reply",
    pinned: false,
    needsUserInput: false,
    workspaceDir: TEST_PROJECT,
    runDir: null,
  },
  {
    id: "t-2",
    updatedAt: new Date(),
    status: "idle",
    title: "Pinned baseline run",
    description: "latest reply",
    pinned: true,
    needsUserInput: false,
    workspaceDir: TEST_PROJECT,
    runDir: null,
  },
];

/** What each search answers: a project's threads, and the cross-project
 *  searches by status (`all` with no status is "No project"'s). */
const lists = vi.hoisted(() => ({
  byProject: {} as Record<string, unknown[]>,
  interrupted: [] as unknown[],
  busy: [] as unknown[],
  all: [] as unknown[],
  scopes: [] as unknown[],
}));

const pinThread = vi.fn(async (..._args: unknown[]) => {});
const renameThread = vi.fn(async (..._args: unknown[]) => {});
const exportThread = vi.fn(async (..._args: unknown[]) => {});
const mutate = vi.fn();

vi.mock("@/app/hooks/useThreads", () => ({
  useThreads: (props: { scope: ThreadScope | null; status?: string }) => {
    lists.scopes.push(props.scope);
    // As the hook does: a search across projects keeps the named ones'
    // threads, "No project" those with no folder.
    const scope = props.scope;
    const items = (
      scope === null
        ? []
        : scope === "noProject"
        ? (lists.all as ThreadItem[]).filter((t) => !t.workspaceDir)
        : "project" in scope
        ? lists.byProject[scope.project] ?? []
        : (
            (props.status === "interrupted"
              ? lists.interrupted
              : lists.busy) as ThreadItem[]
          ).filter(
            (t) => t.workspaceDir && scope.projects.includes(t.workspaceDir)
          )
    ) as unknown[];
    return {
      data: [{ items, full: false }],
      size: 1,
      setSize: vi.fn(),
      mutate,
      isLoading: false,
      error: undefined,
    };
  },
  deleteThread: vi.fn(async () => {}),
  renameThread: (...args: unknown[]) => renameThread(...args),
  pinThread: (...args: unknown[]) => pinThread(...args),
  exportThread: (...args: unknown[]) => exportThread(...args),
}));

import { ThreadList } from "./ThreadList";

function renderList(
  ui: React.ReactElement,
  projects: ProjectsContextValue = mockProjects()
) {
  return render(
    <TestProjectsProvider value={projects}>{ui}</TestProjectsProvider>
  );
}

const thread = (over: Partial<ThreadItem>): ThreadItem => ({
  id: "t-x",
  updatedAt: new Date(),
  status: "idle",
  title: "A thread",
  description: "",
  pinned: false,
  needsUserInput: false,
  workspaceDir: TEST_PROJECT,
  runDir: null,
  ...over,
});

// On touch widths the four per-thread icons collapse into one "⋯" menu so the
// title keeps the row. jsdom applies no CSS, so both the desktop toolbar and the
// menu trigger are in the DOM here; the menu is addressed by its own roles.
describe("ThreadList per-thread actions menu", () => {
  beforeAll(() => {
    // Radix Popper measures its anchor; jsdom has no ResizeObserver.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  beforeEach(() => {
    pinThread.mockClear();
    renameThread.mockClear();
    exportThread.mockClear();
    lists.byProject = { [TEST_PROJECT]: threadFixtures };
    lists.interrupted = [];
    lists.busy = [];
    lists.all = [];
  });

  const openMenu = (title: string) => {
    const trigger = screen.getByRole("button", {
      name: `Actions for "${title}"`,
    });
    fireEvent.keyDown(trigger, { key: "Enter" });
    return trigger;
  };

  // Every test closes the dialog it opens. Unmounting with one still open leaks
  // into the next test in this file: the dialog that test opens from the menu is
  // gone again before it can be queried (passes alone, fails in sequence).
  const closeDialog = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  };

  it("offers pin, rename, export and delete from one trigger", async () => {
    renderList(<ThreadList onThreadSelect={vi.fn()} />);
    const trigger = openMenu("Protein folding survey");

    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Pin",
      "Rename",
      "Export JSON",
      "Delete",
    ]);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("labels the pin item by the thread's pinned state", async () => {
    renderList(<ThreadList onThreadSelect={vi.fn()} />);
    openMenu("Pinned baseline run");

    expect(await screen.findByRole("menuitem", { name: "Unpin" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull();
  });

  it("pins and exports through the same handlers as the toolbar", async () => {
    renderList(<ThreadList onThreadSelect={vi.fn()} />);

    openMenu("Protein folding survey");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(pinThread).toHaveBeenCalledWith("t-1", true));

    openMenu("Protein folding survey");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Export JSON" })
    );
    await waitFor(() =>
      expect(exportThread).toHaveBeenCalledWith("t-1", "Protein folding survey")
    );
  });

  it("opens the rename dialog prefilled with the title", async () => {
    renderList(<ThreadList onThreadSelect={vi.fn()} />);
    openMenu("Protein folding survey");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    expect(await screen.findByText("Rename research")).toBeTruthy();
    expect(
      (screen.getByPlaceholderText("Enter a title…") as HTMLInputElement).value
    ).toBe("Protein folding survey");
    await closeDialog();
  });

  const openRenameWith = async (value: string) => {
    renderList(<ThreadList onThreadSelect={vi.fn()} />);
    openMenu("Protein folding survey");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByPlaceholderText("Enter a title…");
    fireEvent.change(input, { target: { value } });
    return input;
  };

  it("renames on Enter", async () => {
    const input = await openRenameWith("Folding survey v2");

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(renameThread).toHaveBeenCalledWith("t-1", "Folding survey v2")
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // Typing letters with a Chinese or Japanese IME and pressing Enter to put
  // them in the field must not submit the half-typed title. Chrome and Firefox
  // flag that Enter with `isComposing`; Safari sends it after compositionend
  // with keyCode 229 instead.
  it.each([
    ["isComposing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ])(
    "keeps the dialog open on an Enter that ends IME composition (%s)",
    async (_label, init) => {
      const input = await openRenameWith("xin");

      fireEvent.keyDown(input, { key: "Enter", ...init });

      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(renameThread).not.toHaveBeenCalled();
      await closeDialog();
    }
  );

  // The menu item that opened the dialog is unmounted by the time it closes, so
  // Radix has nothing to restore focus to and would drop it on <body>.
  it.each(["Rename", "Delete"])(
    "returns focus to the trigger when the %s dialog is cancelled",
    async (item) => {
      renderList(<ThreadList onThreadSelect={vi.fn()} />);
      const trigger = openMenu("Protein folding survey");
      fireEvent.click(await screen.findByRole("menuitem", { name: item }));

      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.activeElement).toBe(trigger);
      });
    }
  );

  // The viewport can cross `md` while a dialog is open (a rotated phone): the
  // trigger is then `display: none` and cannot take focus.
  it("falls back to the row when the trigger is hidden at close", async () => {
    renderList(<ThreadList onThreadSelect={vi.fn()} />);
    const trigger = openMenu("Protein folding survey");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const cancel = await screen.findByRole("button", { name: "Cancel" });

    trigger.style.display = "none";
    fireEvent.click(cancel);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /^Protein folding survey/ })
      );
    });
  });

  it("opens the delete confirmation and never selects the thread", async () => {
    const onThreadSelect = vi.fn();
    renderList(<ThreadList onThreadSelect={onThreadSelect} />);
    openMenu("Protein folding survey");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(onThreadSelect).not.toHaveBeenCalled();
    await closeDialog();
  });
});

describe("ThreadList by project", () => {
  const two = () =>
    mockProjects(readyProjects(TEST_PROJECT, OTHER), { current: TEST_PROJECT });

  beforeEach(() => {
    lists.byProject = {
      [TEST_PROJECT]: [thread({ id: "a-1", title: "Alpha thread" })],
      [OTHER]: [
        thread({ id: "b-1", title: "Beta thread", workspaceDir: OTHER }),
      ],
    };
    lists.interrupted = [];
    lists.busy = [];
    lists.all = [];
    lists.scopes = [];
  });

  it("opens the current project and reads no closed one", () => {
    renderList(<ThreadList onThreadSelect={vi.fn()} />, two());

    expect(screen.getByText("Alpha thread")).toBeTruthy();
    expect(screen.queryByText("Beta thread")).toBeNull();
    expect(lists.scopes).not.toContainEqual({ project: OTHER });
    const beta = screen.getByRole("button", { name: /^projB/ });
    expect(beta.getAttribute("aria-expanded")).toBe("false");
    expect(beta.getAttribute("title")).toBe(OTHER);

    fireEvent.click(beta);
    expect(screen.getByText("Beta thread")).toBeTruthy();
  });

  it("lists a question waiting in a closed project at the top, with its project, once", () => {
    const waiting = thread({
      id: "b-2",
      title: "Which split?",
      workspaceDir: OTHER,
      status: "interrupted",
      needsUserInput: true,
    });
    lists.interrupted = [waiting];
    lists.byProject[OTHER] = [waiting];
    const onInterruptCountChange = vi.fn();
    renderList(
      <ThreadList
        onThreadSelect={vi.fn()}
        onInterruptCountChange={onInterruptCountChange}
      />,
      two()
    );

    const section = screen.getByRole("region", { name: "Requiring Attention" });
    expect(section.textContent).toContain("Which split?");
    expect(section.textContent).toContain("projB");
    expect(onInterruptCountChange).toHaveBeenLastCalledWith(1);
    expect(
      screen.getByRole("button", { name: /^projB/ }).textContent
    ).toContain("1 waiting for you");

    // Opened, the project doesn't list it a second time.
    fireEvent.click(screen.getByRole("button", { name: /^projB/ }));
    expect(screen.getAllByText("Which split?")).toHaveLength(1);
  });

  it("leaves out waiting threads of folders that aren't projects", () => {
    lists.interrupted = [
      thread({
        id: "c-1",
        title: "Elsewhere",
        workspaceDir: "/home/you/projC",
        status: "interrupted",
        needsUserInput: true,
      }),
    ];
    renderList(<ThreadList onThreadSelect={vi.fn()} />, two());

    expect(
      screen.queryByRole("region", { name: "Requiring Attention" })
    ).toBeNull();
  });

  it("marks a closed project with a running conversation", () => {
    lists.busy = [thread({ id: "b-3", workspaceDir: OTHER, status: "busy" })];
    renderList(<ThreadList onThreadSelect={vi.fn()} />, two());

    const beta = screen.getByRole("region", { name: "projB" });
    expect(
      beta.querySelector('[aria-label="A conversation is running"]')
    ).not.toBeNull();
    const alpha = screen.getByRole("region", { name: "projA" });
    expect(
      alpha.querySelector('[aria-label="A conversation is running"]')
    ).toBeNull();
  });

  it("says when a project's folder is missing", () => {
    renderList(
      <ThreadList onThreadSelect={vi.fn()} />,
      mockProjects(
        readyProjects(TEST_PROJECT, {
          key: OTHER,
          name: "projB",
          missing: true,
        }),
        { current: TEST_PROJECT }
      )
    );

    expect(screen.getByRole("region", { name: "projB" }).textContent).toContain(
      "folder missing"
    );
  });

  it("lists threads with no folder under No project, once opened", () => {
    lists.all = [
      thread({ id: "n-1", title: "Folderless", workspaceDir: null }),
      thread({ id: "n-2", title: "Has a folder" }),
    ];
    renderList(<ThreadList onThreadSelect={vi.fn()} />, two());
    expect(screen.queryByText("Folderless")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /No project/ }));

    expect(screen.getByText("Folderless")).toBeTruthy();
    expect(screen.queryByText("Has a folder")).toBeNull();
  });

  it("tags a thread that works in a run folder", () => {
    lists.byProject[TEST_PROJECT] = [
      thread({
        id: "r-1",
        title: "Run thread",
        runDir: `${TEST_PROJECT}/runs/r1`,
      }),
    ];
    renderList(<ThreadList onThreadSelect={vi.fn()} />, two());

    expect(screen.getByText("runs/r1")).toBeTruthy();
  });

  it("reads the lists once for reloads asked for together", async () => {
    vi.useFakeTimers();
    try {
      let reload: () => void = () => {};
      renderList(
        <ThreadList
          onThreadSelect={vi.fn()}
          onMutateReady={(fn) => {
            reload = fn;
          }}
        />,
        two()
      );
      mutate.mockClear();

      reload();
      reload();
      reload();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      // Each mounted list once: the attention and busy searches and the
      // open project.
      expect(mutate).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
