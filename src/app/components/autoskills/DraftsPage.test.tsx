// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useLayoutEffect, type ReactNode } from "react";
import { toast } from "sonner";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft, DraftList } from "@/lib/autoskills";
import type { ProjectsState } from "@/lib/projects";
import type { ProjectsContextValue } from "@/providers/ProjectsProvider";
import type { SettingSource, SettingsWriteAccess } from "@/lib/settings";
import { animateDialogs, dialogWords } from "@/test/animateDialogs";
import {
  mockProjects,
  readyProjects,
  TestProjectsProvider,
} from "@/test/mockProjects";

// jsdom has no scrollIntoView; Radix Select (the pane's "Install into")
// calls it on the item it focuses when the list opens.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// The URL's query state, shared by every useQueryState of a key (the page
// and SkillsMarketplace both read skillsPage).
const q = vi.hoisted(() => {
  const values = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  return {
    values,
    listeners,
    set: (key: string, value: string | null) => {
      values.set(key, value);
      for (const l of listeners) l();
    },
    writes: [] as Array<[string, string | null]>,
  };
});

vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: (key: string) => {
      const value = react.useSyncExternalStore(
        (l: () => void) => {
          q.listeners.add(l);
          return () => q.listeners.delete(l);
        },
        () => q.values.get(key) ?? null
      );
      const set = (next: string | null) => {
        q.writes.push([key, next]);
        q.set(key, next);
        return Promise.resolve(new URLSearchParams());
      };
      return [value, set];
    },
  };
});

const URL_ = "http://127.0.0.1:6174";

const hooks = vi.hoisted(() => ({
  auto: { status: "loading" } as Record<string, unknown>,
  refresh: vi.fn(async () => undefined),
  mark: vi.fn((_url: string, _at: string) => undefined),
  approve: vi.fn(
    async (
      _drafts: Draft[],
      _scopes?: unknown
    ): Promise<{ done: Draft[]; failed: unknown[] }> => ({
      done: [],
      failed: [],
    })
  ),
  reject: vi.fn(
    async (
      _drafts: Draft[]
    ): Promise<{ done: Draft[]; failed: unknown[] }> => ({
      done: [],
      failed: [],
    })
  ),
  onReverted: undefined as
    | ((drafts: Draft[], reread: Promise<void>) => void)
    | undefined,
  // The real useDraftActions, for a test that follows a decision to the
  // relay.
  realActions: false,
  // The real useAutoSkills, reading the drafts through a stubbed fetch.
  realAuto: false,
  busy: false,
  running: new Set<string>() as ReadonlySet<string>,
  run: vi.fn(async (_key: string) => undefined),
  settings: undefined as Record<string, unknown> | undefined,
  // Where each setting comes from; an override hides the saved value.
  sources: {} as Record<string, SettingSource>,
  access: undefined as SettingsWriteAccess | undefined,
  deployment: { deploymentUrl: "http://127.0.0.1:6174", apiKey: "" },
  // A check of the test's own in place of the real one, when set.
  check: undefined as
    | ((drafts: readonly Draft[], stop?: AbortSignal) => unknown)
    | undefined,
}));

vi.mock("@/app/hooks/useAutoSkills", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/app/hooks/useAutoSkills")
  >();
  return {
    // The same for a whole test, so the hooks called never change.
    useAutoSkills: (options?: { poll?: boolean }) =>
      hooks.realAuto
        ? actual.useAutoSkills(options)
        : { ...hooks.auto, refresh: hooks.refresh },
    markAutoSeen: hooks.mark,
    refreshAutoSkills: hooks.refresh,
    // The real check of a draft's files, reading through a stubbed fetch,
    // unless the test brings its own.
    useDraftFilesCheck: () => {
      const real = actual.useDraftFilesCheck();
      return hooks.check ?? real;
    },
    CHECK_DEADLINE_MS: actual.CHECK_DEADLINE_MS,
  };
});
vi.mock("@/app/hooks/useDraftActions", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/app/hooks/useDraftActions")
  >();
  return {
    ...actual,
    useDraftActions: (
      projects: Parameters<typeof actual.useDraftActions>[0],
      options?: {
        onReverted?: (drafts: Draft[], reread: Promise<void>) => void;
      }
    ) => {
      if (hooks.realActions) return actual.useDraftActions(projects, options);
      hooks.onReverted = options?.onReverted;
      return {
        approve: hooks.approve,
        reject: hooks.reject,
        busy: hooks.busy,
      };
    },
  };
});
vi.mock("@/app/hooks/useSettings", () => ({
  useSettings: () => ({
    payload: hooks.settings
      ? { settings: hooks.settings, sources: hooks.sources }
      : undefined,
  }),
  useSettingsAccess: () => ({ access: hooks.access, refresh: vi.fn() }),
}));
vi.mock("@/providers/ClientProvider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDeployment: () => hooks.deployment,
}));
vi.mock("@/app/components/SkillDetailDialog", () => ({
  SkillDetailDialog: () => null,
}));

import { CHECK_DEADLINE_MS } from "@/app/hooks/useAutoSkills";
import { SkillsMarketplace } from "@/app/components/SkillsMarketplace";
import { RunNowContext } from "@/providers/runNowContext";
import { DraftsPage } from "./DraftsPage";

/** Run now's state, as RunNowProvider keeps it above the views. */
function RunNow({ children }: { children: ReactNode }) {
  return (
    <RunNowContext.Provider value={{ running: hooks.running, run: hooks.run }}>
      {children}
    </RunNowContext.Provider>
  );
}

const A = "/work/EvoSci_test";
const B = "/work/project_B";

function draft(over: Partial<Draft> & { proposal_id: string }): Draft {
  return {
    skill_name: over.proposal_id,
    description: "",
    operation: "create",
    target_skill_name: null,
    scope: "workspace",
    submitted_scope: null,
    status: "pending",
    workspace_dir: A,
    created_at: "2026-11-01T09:00:00Z",
    updated_at: "2026-11-01T09:00:00Z",
    approved_at: null,
    approved_by: null,
    rejected_at: null,
    approved_skill_path: null,
    approved_skill_present: null,
    source_observation_ids: [],
    skill_md: "",
    skill_md_truncated: false,
    rationale_md: "",
    rationale_md_truncated: false,
    files: [],
    install_target: null,
    install_base: null,
    install_error: null,
    ...over,
  };
}

function listOf(drafts: Draft[]): DraftList {
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const d of drafts) counts[d.status] += 1;
  return { drafts, counts, byProject: {} };
}

function ready(drafts: Draft[]) {
  hooks.auto = { status: "ready", list: listOf(drafts) };
}

function page(
  projects: ProjectsState = readyProjects(A, B),
  over: Partial<ProjectsContextValue> = {},
  after?: ReactNode
) {
  // Each mount reads files with a cache of its own; a rerender keeps it.
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TestProjectsProvider value={{ ...mockProjects(projects), ...over }}>
        <RunNow>
          <DraftsPage />
          {after}
        </RunNow>
      </TestProjectsProvider>
    </SWRConfig>
  );
}

const selection = () => screen.queryByRole("region", { name: "Selection" });
const pick = (name: string) =>
  fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));

beforeEach(() => {
  q.values.clear();
  q.writes = [];
  hooks.auto = { status: "loading" };
  hooks.busy = false;
  hooks.running = new Set();
  hooks.settings = {
    memory_skill_synthesis_enabled: true,
    memory_skill_synthesis_mode: "review",
    memory_skill_synthesis_cadence: "weekly",
    memory_skill_synthesis_time: "03:00",
  };
  hooks.sources = {};
  hooks.access = { writable: true };
  hooks.realActions = false;
  hooks.realAuto = false;
  hooks.deployment = { deploymentUrl: URL_, apiKey: "" };
  hooks.check = undefined;
});
// Restored here, so a failing assertion can't leak them into other tests.
let focusSpy: { mockRestore(): void } | undefined;
let toastSpy: { mockRestore(): void } | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  focusSpy?.mockRestore();
  focusSpy = undefined;
  toastSpy?.mockRestore();
  toastSpy = undefined;
});

describe("DraftsPage", () => {
  it("selection drops drafts that left the pending list", () => {
    const x = draft({ proposal_id: "x" });
    const y = draft({ proposal_id: "y", created_at: "2026-10-01T09:00:00Z" });
    const z = draft({ proposal_id: "z", workspace_dir: B });
    ready([x, y, z]);
    const view = render(page());

    expect(selection()).toBeNull();
    pick("x");
    pick("z");
    expect(selection()?.textContent).toContain("2 selected");

    // x was approved elsewhere (the CLI, another tab).
    ready([{ ...x, status: "approved" }, y, z]);
    view.rerender(page());
    expect(selection()?.textContent).toContain("1 selected");

    // Back in Pending (an Undo), it comes back unpicked.
    ready([x, y, z]);
    view.rerender(page());
    expect(selection()?.textContent).toContain("1 selected");
    expect(
      (screen.getByRole("checkbox", { name: "Select x" }) as HTMLInputElement)
        .checked
    ).toBe(false);

    // Bulk Approve passes no scopes: each draft installs where it records.
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    expect(hooks.approve).toHaveBeenCalledTimes(1);
    expect(hooks.approve.mock.calls[0]).toEqual([[z]]);

    // Reject acts at once on the selection.
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Reject" })
    );
    expect(hooks.reject.mock.calls[0]).toEqual([[z]]);

    // A tab change clears the selection.
    fireEvent.click(screen.getByRole("tab", { name: /^Approved/ }));
    fireEvent.click(screen.getByRole("tab", { name: /^Pending/ }));
    expect(selection()).toBeNull();

    // Clear empties it too.
    pick("y");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Clear" })
    );
    expect(selection()).toBeNull();
  });

  it("selection drops drafts whose project was removed", () => {
    const x = draft({ proposal_id: "x" });
    const z = draft({ proposal_id: "z", workspace_dir: B });
    ready([x, z]);
    const view = render(page());
    pick("x");
    pick("z");
    expect(selection()?.textContent).toContain("2 selected");

    // While the projects are being read again nothing is dropped for them.
    view.rerender(page({ status: "pending" }));
    expect(selection()?.textContent).toContain("2 selected");

    // EvoSci_test was removed; its drafts are not re-read yet.
    view.rerender(page(readyProjects(B)));
    expect(selection()?.textContent).toContain("1 selected");
    expect(
      (screen.getByRole("checkbox", { name: "Select x" }) as HTMLInputElement)
        .checked
    ).toBe(false);
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    expect(hooks.approve.mock.calls[0]).toEqual([[z]]);
  });

  it("an open draft that left the list shows the empty pane", () => {
    const x = draft({ proposal_id: "x", skill_name: "arxiv-paper-retrieval" });
    const y = draft({ proposal_id: "y", created_at: "2026-10-01T09:00:00Z" });
    ready([x, y]);
    q.values.set("draftId", "x");
    const view = render(page());

    const row = screen.getByRole("button", { name: "arxiv-paper-retrieval" });
    expect(row.getAttribute("aria-current")).toBe("true");
    // Beside the list (no phone), opening leaves the focus where it was.
    expect(document.activeElement).toBe(document.body);
    expect(screen.queryByText("Select a draft to read it.")).toBeNull();

    // On a phone the draft takes the list's place, with a way back.
    fireEvent.click(screen.getByRole("button", { name: "Back to drafts" }));
    expect(q.writes).toContainEqual(["draftId", null]);
    expect(screen.getByText("Select a draft to read it.")).toBeTruthy();

    // Opened again, then decided elsewhere: it leaves Pending.
    row.focus();
    fireEvent.click(row);
    expect(q.values.get("draftId")).toBe("x");
    // Beside the list the row keeps the focus (the phone moves it).
    expect(document.activeElement).toBe(row);
    ready([{ ...x, status: "approved" }, y]);
    view.rerender(page());
    expect(screen.getByText("Select a draft to read it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to drafts" })).toBeNull();

    // A draftId naming nothing in the list shows the empty pane too.
    q.set("draftId", "nope");
    ready([x, y]);
    view.rerender(page());
    expect(screen.getByText("Select a draft to read it.")).toBeTruthy();

    // A tab with nothing in it has no pane: its empty state says it all.
    ready([
      { ...x, status: "approved" },
      { ...y, status: "approved" },
    ]);
    view.rerender(page());
    expect(
      screen.getByText("All caught up — nothing waits for review.")
    ).toBeTruthy();
    expect(screen.queryByText("Select a draft to read it.")).toBeNull();
  });

  it("bulk approve with an update asks first and names it", () => {
    const u1 = draft({
      proposal_id: "u1",
      skill_name: "paper-review-v2",
      operation: "update",
      target_skill_name: "paper-review",
      created_at: "2026-11-03T09:00:00Z",
    });
    const u2 = draft({
      proposal_id: "u2",
      skill_name: "lit-search",
      operation: "update",
      created_at: "2026-11-02T09:00:00Z",
    });
    const u3 = draft({
      proposal_id: "u3",
      skill_name: "chunk-verifier",
      operation: "update",
      workspace_dir: B,
    });
    const c = draft({ proposal_id: "c", created_at: "2026-11-01T09:00:00Z" });
    ready([u1, u2, u3, c]);
    render(page());
    const approve = () =>
      fireEvent.click(
        within(selection()!).getByRole("button", { name: "Approve" })
      );

    pick("paper-review-v2");
    pick("c");
    approve();
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText("This replaces the installed paper-review.")
    ).toBeTruthy();
    expect(hooks.approve).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hooks.approve).not.toHaveBeenCalled();

    pick("lit-search");
    approve();
    expect(
      screen.getByText(
        "This replaces the installed paper-review and lit-search."
      )
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Replace and install" })
    );
    expect(hooks.approve).toHaveBeenCalledTimes(1);
    // One argument: no scopes, each draft keeps its recorded one.
    expect(hooks.approve.mock.calls[0]).toEqual([[u1, u2, c]]);

    pick("chunk-verifier");
    approve();
    expect(
      screen.getByText(
        "This replaces the installed paper-review, lit-search and chunk-verifier."
      )
    ).toBeTruthy();
  });

  // Updates recorded for a project whose skill is installed only globally:
  // the approval copies it into the project, and the global one stays.
  const G = "/home/u/.evoscientist/skills";
  const projectCopy = (
    id: string,
    name: string,
    project: string,
    created_at = "2026-11-01T09:00:00Z"
  ) =>
    draft({
      proposal_id: id,
      skill_name: name,
      operation: "update",
      target_skill_name: name,
      workspace_dir: project,
      created_at,
      install_target: `${project}/skills/${name}`,
      install_base: `${G}/${name}`,
    });
  const approveSelected = () =>
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );

  it("bulk approve of project copies says the global skills stay", () => {
    const c1 = projectCopy("c1", "data-cleaning", B);
    const c2 = projectCopy("c2", "lit-search", A);
    ready([c1, c2]);
    render(page());

    pick("data-cleaning");
    approveSelected();
    let dialog = screen.getByRole("dialog", {
      name: "Install a project copy?",
    });
    expect(
      within(dialog).getByText(
        "project_B gets its own data-cleaning with these changes; the global data-cleaning stays as it is."
      )
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "Replace and install" })
    ).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(hooks.approve).not.toHaveBeenCalled();

    pick("lit-search");
    approveSelected();
    dialog = screen.getByRole("dialog", { name: "Install project copies?" });
    expect(
      within(dialog).getByText(
        "lit-search and data-cleaning get their own copies in their projects; the global skills stay as they are."
      )
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    // One argument: no scopes, each draft keeps its recorded one.
    expect(hooks.approve.mock.calls).toEqual([[[c2, c1]]]);
  });

  it("bulk approve of replaces and project copies says both, the replace first", () => {
    // In place: the folder written is the one the result starts from.
    const r = draft({
      proposal_id: "r",
      skill_name: "paper-review-v2",
      operation: "update",
      target_skill_name: "paper-review",
      created_at: "2026-11-03T09:00:00Z",
      install_target: `${A}/skills/paper-review`,
      install_base: `${A}/skills/paper-review`,
    });
    const c1 = projectCopy("c1", "data-cleaning", B, "2026-11-02T09:00:00Z");
    const c2 = projectCopy("c2", "lit-search", B);
    const n = draft({ proposal_id: "n" });
    ready([r, c1, c2, n]);
    render(page());

    pick("paper-review-v2");
    pick("data-cleaning");
    pick("n");
    approveSelected();
    let dialog = screen.getByRole("dialog", {
      name: "Install updated skills?",
    });
    expect(
      within(dialog).getByText(
        "This replaces the installed paper-review. project_B gets its own data-cleaning with these changes; the global data-cleaning stays as it is."
      )
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "Install" })
    ).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    pick("lit-search");
    approveSelected();
    dialog = screen.getByRole("dialog", { name: "Install updated skills?" });
    expect(
      within(dialog).getByText(
        "This replaces the installed paper-review. data-cleaning and lit-search get their own copies in their projects; the global skills stay as they are."
      )
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Replace and install" })
    );
    expect(hooks.approve.mock.calls).toEqual([[[r, n, c1, c2]]]);
  });

  /** One update selected and its question asked, with dialogs that fade
   *  out as in a browser. */
  function askAboutOneUpdate() {
    animateDialogs();
    const u = draft({
      proposal_id: "u",
      operation: "update",
      target_skill_name: "paper-review",
    });
    ready([u]);
    render(page());
    pick("u");
    approveSelected();
    const dialog = screen.getByRole("dialog", {
      name: "Replace an installed skill?",
    });
    const confirm = within(dialog).getByRole("button", {
      name: "Replace and install",
    });
    return { u, dialog, confirm };
  }

  it("the question keeps its words while it fades out", async () => {
    const { u, dialog, confirm } = askAboutOneUpdate();
    const asked = dialogWords(dialog);
    expect(asked).toEqual({
      title: "Replace an installed skill?",
      description: "This replaces the installed paper-review.",
      buttons: ["Cancel", "Replace and install"],
    });

    // The decision's answers empty the selection while the dialog is still
    // fading out (200 ms in a browser).
    hooks.approve.mockResolvedValueOnce({ done: [u], failed: [] });
    fireEvent.click(confirm);
    // The modal hides the page from role queries until it is gone.
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Selection", hidden: true })
      ).toBeNull()
    );
    expect(dialog.isConnected).toBe(true);
    expect(dialog.getAttribute("data-state")).toBe("closed");
    expect(dialogWords(dialog)).toEqual(asked);
  });

  it("a click on the question while it fades out after Cancel sends nothing", () => {
    const { dialog, confirm } = askAboutOneUpdate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(dialog.isConnected).toBe(true);
    expect(dialog.getAttribute("data-state")).toBe("closed");
    fireEvent.click(confirm);
    expect(hooks.approve).not.toHaveBeenCalled();
  });

  it("a second click on the question while it fades out doesn't approve again", () => {
    const { u, dialog, confirm } = askAboutOneUpdate();
    fireEvent.click(confirm);
    expect(dialog.isConnected).toBe(true);
    expect(dialog.getAttribute("data-state")).toBe("closed");
    fireEvent.click(confirm);
    expect(hooks.approve.mock.calls).toEqual([[[u]]]);
  });

  it("the question goes when its update leaves the selection", () => {
    const u = draft({
      proposal_id: "u",
      operation: "update",
      target_skill_name: "paper-review",
    });
    const c = draft({ proposal_id: "c", created_at: "2026-10-01T09:00:00Z" });
    ready([u, c]);
    const view = render(page());
    pick("u");
    pick("c");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    expect(screen.getByRole("dialog")).toBeTruthy();

    // u was decided in the CLI meanwhile: nothing to replace any more.
    ready([{ ...u, status: "rejected" }, c]);
    view.rerender(page());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hooks.approve).not.toHaveBeenCalled();

    // Back and picked again: the question waits for Approve.
    ready([u, c]);
    view.rerender(page());
    pick("u");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an open question follows the re-read and approves only what is left", () => {
    const u1 = draft({
      proposal_id: "u1",
      operation: "update",
      target_skill_name: "paper-review",
    });
    const u2 = draft({
      proposal_id: "u2",
      skill_name: "lit-search",
      operation: "update",
      created_at: "2026-10-30T09:00:00Z",
    });
    const c = draft({ proposal_id: "c", created_at: "2026-10-01T09:00:00Z" });
    ready([u1, u2, c]);
    const view = render(page());
    pick("u1");
    pick("lit-search");
    pick("c");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    expect(
      screen.getByText(
        "This replaces the installed paper-review and lit-search."
      )
    ).toBeTruthy();

    // lit-search was rejected in the CLI while the question was open.
    ready([u1, { ...u2, status: "rejected" }, c]);
    view.rerender(page());
    expect(
      screen.getByText("This replaces the installed paper-review.")
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Replace and install" })
    );
    expect(hooks.approve.mock.calls).toEqual([[[u1, c]]]);
  });

  it("names a repeated skill with its project", () => {
    const a = draft({
      proposal_id: "a",
      operation: "update",
      target_skill_name: "paper-review",
    });
    const b = draft({
      proposal_id: "b",
      operation: "update",
      target_skill_name: "paper-review",
      workspace_dir: B,
    });
    const l = draft({
      proposal_id: "l",
      operation: "update",
      target_skill_name: "lit-search",
      workspace_dir: B,
      created_at: "2026-10-01T09:00:00Z",
    });
    ready([a, b, l]);
    render(page());
    pick("a");
    pick("b");
    pick("l");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    expect(
      screen.getByText(
        "This replaces the installed paper-review (EvoSci_test), paper-review (project_B) and lit-search."
      )
    ).toBeTruthy();
  });

  it("focus comes back after the question and after a bulk decision", async () => {
    const u = draft({
      proposal_id: "u",
      operation: "update",
      target_skill_name: "paper-review",
    });
    const c = draft({ proposal_id: "c", created_at: "2026-10-01T09:00:00Z" });
    ready([u, c]);
    const view = render(page());
    const approveButton = () =>
      within(selection()!).getByRole("button", { name: "Approve" });

    // Cancel gives the focus back to Approve (the dialog has no trigger).
    pick("u");
    approveButton().focus();
    fireEvent.click(approveButton());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Radix gives the focus on the next tick.
    await waitFor(() => expect(document.activeElement).toBe(approveButton()));

    // Replace and install: back to Approve, and once the re-read empties the
    // selection (the bar goes), to the selected tab.
    fireEvent.click(approveButton());
    fireEvent.click(
      screen.getByRole("button", { name: "Replace and install" })
    );
    await waitFor(() => expect(document.activeElement).toBe(approveButton()));
    ready([{ ...u, status: "approved" }, c]);
    view.rerender(page());
    expect(selection()).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { selected: true })
    );

    // A bulk Approve without a question, the same way.
    pick("c");
    approveButton().focus();
    fireEvent.click(approveButton());
    expect(hooks.approve).toHaveBeenLastCalledWith([c]);
    ready([
      { ...u, status: "approved" },
      { ...c, status: "approved" },
    ]);
    view.rerender(page());
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { selected: true })
    );
  });

  it("on a phone the open draft takes the focus and Back returns it", () => {
    // Narrower than 768 px: no query matches, "(min-width: 768px)" included.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focusSpy = focus;
    ready([
      draft({ proposal_id: "x", skill_name: "arxiv-paper-retrieval" }),
      draft({ proposal_id: "y", created_at: "2026-10-01T09:00:00Z" }),
    ]);
    render(page());

    fireEvent.click(
      screen.getByRole("button", { name: "arxiv-paper-retrieval" })
    );
    const back = screen.getByRole("button", { name: "Back to drafts" });
    expect(document.activeElement).toBe(back);

    fireEvent.click(back);
    expect(screen.queryByRole("button", { name: "Back to drafts" })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "arxiv-paper-retrieval" })
    );
    // Never scrolled there.
    expect(focus.mock.calls.length).toBeGreaterThan(0);
    for (const call of focus.mock.calls) {
      expect(call[0]).toEqual({ preventScroll: true });
    }
  });

  it("no decision before the projects are known", () => {
    const u = draft({
      proposal_id: "u",
      operation: "update",
      target_skill_name: "paper-review",
    });
    const z = draft({ proposal_id: "z", workspace_dir: B });
    ready([u, z]);
    const view = render(page({ status: "pending" }));
    const disabled = (el: HTMLElement) =>
      (el as HTMLButtonElement | HTMLInputElement).disabled;

    // Not known yet: nothing to pick, nothing runs.
    for (const box of screen.getAllByRole("checkbox")) {
      expect(disabled(box)).toBe(true);
    }
    for (const run of screen.getAllByRole("button", { name: "Run now" })) {
      expect(disabled(run)).toBe(true);
    }

    // A selection (and a question) made while they were known waits once
    // they are being read again.
    view.rerender(page());
    pick("u");
    pick("z");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(page({ status: "pending" }));
    expect(
      disabled(screen.getByRole("button", { name: "Replace and install" }))
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Replace and install" })
    );
    expect(hooks.approve).not.toHaveBeenCalled();

    // Behind the question (aria-hidden by the modal), the bar waits too.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(selection()?.textContent).toContain("2 selected");
    for (const name of ["Approve", "Reject"]) {
      expect(disabled(within(selection()!).getByRole("button", { name }))).toBe(
        true
      );
    }
    for (const run of screen.getAllByRole("button", { name: "Run now" })) {
      expect(disabled(run)).toBe(true);
    }
    expect(hooks.reject).not.toHaveBeenCalled();
  });

  it("no decision while the projects are being read again", () => {
    const u = draft({
      proposal_id: "u",
      operation: "update",
      target_skill_name: "paper-review",
    });
    const z = draft({ proposal_id: "z", workspace_dir: B });
    ready([u, z]);
    // The last list stays "ready" while it is read again.
    const reading = { refreshing: true, isReady: () => false };
    const view = render(page(readyProjects(A, B), reading));
    const disabled = (el: HTMLElement) =>
      (el as HTMLButtonElement | HTMLInputElement).disabled;

    for (const box of screen.getAllByRole("checkbox")) {
      expect(disabled(box)).toBe(true);
    }
    for (const run of screen.getAllByRole("button", { name: "Run now" })) {
      expect(disabled(run)).toBe(true);
    }

    // A selection and a question from before the read wait for its answer.
    view.rerender(page());
    pick("u");
    pick("z");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    view.rerender(page(readyProjects(A, B), reading));
    expect(
      disabled(screen.getByRole("button", { name: "Replace and install" }))
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    for (const name of ["Approve", "Reject"]) {
      expect(disabled(within(selection()!).getByRole("button", { name }))).toBe(
        true
      );
    }

    // The answer keeps both projects: the selection is still there.
    view.rerender(page());
    expect(selection()?.textContent).toContain("2 selected");
    expect(
      disabled(within(selection()!).getByRole("button", { name: "Approve" }))
    ).toBe(false);
  });

  it("a click while the projects gate is closed sends nothing", () => {
    const u = draft({
      proposal_id: "u",
      operation: "update",
      target_skill_name: "paper-review",
    });
    const c = draft({ proposal_id: "c", created_at: "2026-10-01T09:00:00Z" });
    ready([u, c]);
    // A read has just started: the gate is closed, the render that says so
    // hasn't come yet.
    const gate = { open: true };
    render(page(readyProjects(A, B), { isReady: () => gate.open }));
    const bar = () => within(selection()!);

    pick("c");
    gate.open = false;
    fireEvent.click(bar().getByRole("button", { name: "Approve" }));
    fireEvent.click(bar().getByRole("button", { name: "Reject" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "project_B" })).getByRole(
        "button",
        { name: "Run now" }
      )
    );
    expect(hooks.approve).not.toHaveBeenCalled();
    expect(hooks.reject).not.toHaveBeenCalled();
    expect(hooks.run).not.toHaveBeenCalled();

    // The question: asked while open, answered while closed.
    gate.open = true;
    pick("u");
    fireEvent.click(bar().getByRole("button", { name: "Approve" }));
    gate.open = false;
    fireEvent.click(
      screen.getByRole("button", { name: "Replace and install" })
    );
    expect(hooks.approve).not.toHaveBeenCalled();
    // It stays, to be answered once the read is done.
    expect(screen.getByRole("dialog")).toBeTruthy();
    gate.open = true;
    fireEvent.click(
      screen.getByRole("button", { name: "Replace and install" })
    );
    expect(hooks.approve.mock.calls).toEqual([[[u, c]]]);
  });

  it("a decision under way keeps the focus with the bar", () => {
    const x = draft({ proposal_id: "x" });
    ready([x]);
    const view = render(page());
    pick("x");
    const approve = within(selection()!).getByRole("button", {
      name: "Approve",
    }) as HTMLButtonElement;
    approve.focus();
    fireEvent.click(approve);

    // The decision runs and Approve turns off. Chrome blurs a button the
    // moment it turns off: a focusout with no new target, the focus on the
    // page. jsdom keeps it focused, so the page's view of the focus is
    // stubbed until the render is done.
    approve.disabled = true;
    fireEvent.focusOut(approve, { relatedTarget: null });
    const active = vi
      .spyOn(document, "activeElement", "get")
      .mockReturnValue(document.body);
    try {
      hooks.busy = true;
      view.rerender(page());
    } finally {
      active.mockRestore();
    }
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { selected: true })
    );
  });

  it("focus the user moved away stays there when the selection empties", () => {
    const x = draft({ proposal_id: "x" });
    ready([x]);
    const view = render(page());
    pick("x");
    const approve = within(selection()!).getByRole("button", {
      name: "Approve",
    });
    approve.focus();
    // Focus left for the page itself (a click on plain text).
    approve.blur();
    expect(document.activeElement).toBe(document.body);

    // A background re-read decides x elsewhere: the bar goes, the focus
    // isn't pulled to the tab.
    ready([{ ...x, status: "rejected" }]);
    view.rerender(page());
    expect(selection()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("shows the empty states per tab", () => {
    ready([]);
    render(page());

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Pending 0",
      "Approved 0",
      "Rejected 0",
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByText("All caught up — nothing waits for review.")
    ).toBeTruthy();
    // Every registered project still has its group on Pending.
    expect(screen.getAllByText("No drafts waiting.")).toHaveLength(2);

    fireEvent.click(screen.getByRole("tab", { name: "Approved 0" }));
    expect(q.values.get("draftsTab")).toBe("approved");
    expect(screen.getByText("Nothing here yet.")).toBeTruthy();
    expect(screen.queryByText("No drafts waiting.")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Rejected 0" }));
    expect(q.values.get("draftsTab")).toBe("rejected");
    expect(screen.getByText("Nothing here yet.")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Pending 0" }));
    expect(q.values.get("draftsTab")).toBeNull();
  });

  it("the tabs move with arrows, Home and End", () => {
    ready([
      draft({ proposal_id: "x" }),
      draft({ proposal_id: "r", status: "rejected" }),
    ]);
    render(page());
    const tab = (name: RegExp) => screen.getByRole("tab", { name });

    expect(tab(/^Pending 1/).tabIndex).toBe(0);
    expect(tab(/^Approved 0/).tabIndex).toBe(-1);
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tab(/^Pending/).id);

    fireEvent.keyDown(tab(/^Pending/), { key: "ArrowRight" });
    expect(q.values.get("draftsTab")).toBe("approved");
    expect(document.activeElement).toBe(tab(/^Approved/));
    fireEvent.keyDown(tab(/^Approved/), { key: "End" });
    expect(q.values.get("draftsTab")).toBe("rejected");
    expect(document.activeElement).toBe(tab(/^Rejected 1/));
    fireEvent.keyDown(tab(/^Rejected/), { key: "ArrowRight" });
    expect(q.values.get("draftsTab")).toBeNull();
    fireEvent.keyDown(tab(/^Pending/), { key: "ArrowLeft" });
    expect(q.values.get("draftsTab")).toBe("rejected");
    fireEvent.keyDown(tab(/^Rejected/), { key: "Home" });
    expect(q.values.get("draftsTab")).toBeNull();
    expect(document.activeElement).toBe(tab(/^Pending/));
  });

  it("an old core shows only settings and the update notice", async () => {
    hooks.auto = { status: "unsupported" };
    render(page());
    expect(
      screen.getByRole("button", { name: "Research Skills" })
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Every project · runs weekly at 03:00 · you review each draft"
      )
    ).toBeTruthy();
    expect(
      screen.getByText("Update EvoScientist to review drafts here.")
    ).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(settings.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(settings);
    expect(settings.getAttribute("aria-expanded")).toBe("true");
    // The panel only needs /api/settings, so it opens on an old core too.
    expect(screen.getByText("AutoSkills settings")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(settings.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(settings));
  });

  it("a failed read offers Retry", () => {
    hooks.auto = { status: "error", error: new Error("500") };
    render(page());
    expect(screen.getByText("Couldn't read the drafts.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(hooks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("tablist")).toBeNull();
    // No list was read before it: nothing to keep showing.
    expect(screen.queryByText(/This list may be out of date/)).toBeNull();
  });

  // A poll, a focus read or a busy core's timeout can fail in the middle of
  // a review: the list read last stays, under a line that says so, and
  // nothing is decided from it until a read answers.
  describe("a re-read of the drafts that fails", () => {
    const AGAIN =
      "Couldn't read the drafts again. This list may be out of date.";
    /** The latest read failed: the error, with the list read before it. */
    const fail = (over: Record<string, unknown> = {}) => {
      hooks.auto = {
        status: "error",
        error: new Error("500"),
        list: hooks.auto.list,
        ...over,
      };
    };
    /** A read answered with equal drafts: SWR keeps the list's object. */
    const recover = () => {
      hooks.auto = { status: "ready", list: hooks.auto.list };
    };
    const pane = () =>
      within(
        screen.getByRole("heading", { level: 3, hidden: true }).parentElement!
      );
    const off = (button: HTMLElement) => (button as HTMLButtonElement).disabled;

    it("keeps the list under a line that says so, with Retry, and decides nothing", () => {
      const x = draft({
        proposal_id: "x",
        skill_name: "arxiv-paper-retrieval",
      });
      const z = draft({ proposal_id: "z", workspace_dir: B });
      ready([x, z]);
      q.values.set("draftId", "x");
      const view = render(page());
      pick("z");
      expect(screen.queryByRole("alert")).toBeNull();

      fail();
      view.rerender(page());
      expect(screen.getByRole("alert").textContent).toBe(AGAIN);
      expect(screen.queryByText("Couldn't read the drafts.")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(hooks.refresh).toHaveBeenCalledTimes(1);

      // The tabs, the rows, the selection and the open draft are all there.
      expect(screen.getByRole("tab", { name: /^Pending 2/ })).toBeTruthy();
      expect(selection()?.textContent).toContain("1 selected");
      expect(
        pane().getByRole("heading", { name: "arxiv-paper-retrieval" })
      ).toBeTruthy();

      // No decision: the bar's and the pane's are off.
      for (const box of [within(selection()!), pane()]) {
        for (const name of ["Approve", "Reject"]) {
          const button = box.getByRole("button", { name });
          expect(off(button)).toBe(true);
          fireEvent.click(button);
        }
      }
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(hooks.reject).not.toHaveBeenCalled();

      // Run now decides nothing: it is left as it was.
      const run = within(
        screen.getByRole("group", { name: "project_B" })
      ).getByRole("button", { name: "Run now" });
      expect(off(run)).toBe(false);
      fireEvent.click(run);
      expect(hooks.run).toHaveBeenCalledWith(B);

      // A read answers: the line goes and the decisions are back.
      recover();
      view.rerender(page());
      expect(screen.queryByRole("alert")).toBeNull();
      fireEvent.click(
        within(selection()!).getByRole("button", { name: "Reject" })
      );
      expect(hooks.reject.mock.calls).toEqual([[[z]]]);
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      expect(hooks.approve.mock.calls).toEqual([[[x], { x: "workspace" }]]);
    });

    it("the open draft keeps the place picked and its open question", () => {
      const u = draft({
        proposal_id: "u",
        skill_name: "paper-review-v2",
        operation: "update",
        target_skill_name: "paper-review",
        scope: "global",
      });
      ready([u]);
      q.values.set("draftId", "u");
      const view = render(page());
      fireEvent.click(pane().getByLabelText("Install into"));
      fireEvent.click(
        screen.getByRole("option", {
          name: "EvoSci_test/skills (this project)",
        })
      );
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      const question = () =>
        screen.getByRole("dialog", { name: "Install a project copy?" });
      const install = () =>
        within(question()).getByRole("button", { name: "Install" });
      expect(off(install())).toBe(false);

      // The read fails under the open question: it stays, but can't be
      // answered yet.
      fail();
      view.rerender(page());
      expect(off(install())).toBe(true);
      fireEvent.click(install());
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(pane().getByLabelText("Install into").textContent).toBe(
        "EvoSci_test/skills (this project)"
      );

      // A read answers: the same question, answered with the place picked.
      recover();
      view.rerender(page());
      fireEvent.click(install());
      expect(hooks.approve.mock.calls).toEqual([[[u], { u: "workspace" }]]);
    });

    it("the bulk question stays open, to be answered once a read answers", () => {
      const u = draft({
        proposal_id: "u",
        skill_name: "paper-review-v2",
        operation: "update",
        target_skill_name: "paper-review",
      });
      const c = draft({ proposal_id: "c", created_at: "2026-10-01T09:00:00Z" });
      ready([u, c]);
      const view = render(page());
      pick("paper-review-v2");
      pick("c");
      fireEvent.click(
        within(selection()!).getByRole("button", { name: "Approve" })
      );
      const question = () =>
        screen.getByRole("dialog", { name: "Replace an installed skill?" });
      const replace = () =>
        within(question()).getByRole("button", { name: "Replace and install" });

      fail();
      view.rerender(page());
      expect(off(replace())).toBe(true);
      fireEvent.click(replace());
      expect(hooks.approve).not.toHaveBeenCalled();

      recover();
      view.rerender(page());
      expect(off(replace())).toBe(false);
      fireEvent.click(replace());
      expect(hooks.approve.mock.calls).toEqual([[[u, c]]]);
    });

    it("the list coming back as it was releases no decision's hold and unpicks nothing", async () => {
      const x = draft({ proposal_id: "x" });
      const y = draft({ proposal_id: "y", created_at: "2026-10-15T09:00:00Z" });
      const z = draft({ proposal_id: "z", created_at: "2026-10-01T09:00:00Z" });
      ready([x, y, z]);
      hooks.approve.mockResolvedValueOnce({ done: [z], failed: [] });
      const view = render(page());
      const box = (name: string) =>
        screen.getByRole("checkbox", {
          name: `Select ${name}`,
        }) as HTMLInputElement;
      // z decided here: held until a list after the decision.
      pick("z");
      fireEvent.click(
        within(selection()!).getByRole("button", { name: "Approve" })
      );
      await waitFor(() => expect(box("z").disabled).toBe(true));
      pick("x");
      pick("y");
      expect(selection()?.textContent).toContain("2 selected");

      // The decision's re-read fails: the list from before it stays.
      fail();
      view.rerender(page());
      expect(selection()?.textContent).toContain("2 selected");
      expect(box("z").disabled).toBe(true);
      // Picking is no decision: it stays possible.
      expect(box("x").disabled).toBe(false);

      // The list object comes back unchanged: it is still the one from
      // before the decision, so z stays held, and nothing is unpicked.
      recover();
      view.rerender(page());
      expect(selection()?.textContent).toContain("2 selected");
      expect(box("z").disabled).toBe(true);

      // The list after the decision takes over.
      ready([x, y, { ...z, status: "approved" }]);
      view.rerender(page());
      expect(selection()?.textContent).toContain("2 selected");
      expect(screen.queryByRole("checkbox", { name: "Select z" })).toBeNull();
    });

    // The page and its real reader together: the tests above hand the page
    // the reader's state; this one reads it from a backend that goes down.
    it("with the real reader: a read that fails keeps the page as it was, and Retry's answer brings the decisions back", async () => {
      hooks.realAuto = true;
      const x = draft({
        proposal_id: "x",
        skill_name: "arxiv-paper-retrieval",
      });
      const z = draft({ proposal_id: "z", workspace_dir: B });
      let down = false;
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          down
            ? new Response("", { status: 500 })
            : new Response(
                JSON.stringify({
                  proposals: [x, z],
                  counts: { pending: 2, approved: 0, rejected: 0 },
                  by_project: {},
                })
              )
      );
      vi.stubGlobal("fetch", fetchMock);
      q.values.set("draftId", "x");
      render(page());
      await screen.findByRole("tab", { name: /^Pending 2/ });
      pick("z");
      fireEvent.click(pane().getByLabelText("Install into"));
      fireEvent.click(
        screen.getByRole("option", { name: "All projects (global)" })
      );
      const reads = fetchMock.mock.calls.length;

      // The backend goes down, and SWR reads again: on the browser coming
      // back online here (a focus read is throttled for 5 s after the mount).
      down = true;
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
      expect((await screen.findByRole("alert")).textContent).toBe(AGAIN);
      expect(fetchMock.mock.calls.length).toBe(reads + 1);
      // All of it is still there, and nothing can be decided.
      expect(screen.getByRole("tab", { name: /^Pending 2/ })).toBeTruthy();
      expect(selection()?.textContent).toContain("1 selected");
      expect(pane().getByLabelText("Install into").textContent).toBe(
        "All projects (global)"
      );
      for (const box of [within(selection()!), pane()]) {
        for (const name of ["Approve", "Reject"]) {
          expect(off(box.getByRole("button", { name }))).toBe(true);
        }
      }

      // It is back: Retry reads, the line goes, and the page is as it was
      // left, with the place picked.
      down = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(selection()?.textContent).toContain("1 selected");
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      expect(hooks.approve.mock.calls).toEqual([[[x], { x: "global" }]]);
      fireEvent.click(
        within(selection()!).getByRole("button", { name: "Reject" })
      );
      expect(hooks.reject.mock.calls).toEqual([[[z]]]);
    });

    it("an Undo's hold waits through the failed read, and goes with the read that answers", async () => {
      const x = draft({ proposal_id: "x", updated_at: "2026-11-06T12:00:00Z" });
      ready([x]);
      const view = render(page());
      const box = () =>
        screen.getByRole("checkbox", { name: "Select x" }) as HTMLInputElement;
      let settle = () => {};
      const reread = new Promise<void>((resolve) => {
        settle = resolve;
      });
      act(() => hooks.onReverted?.([x], reread));
      expect(box().disabled).toBe(true);

      // The Undo's own re-read fails, and settles.
      fail({ isValidating: false });
      view.rerender(page());
      await act(async () => settle());
      expect(box().disabled).toBe(true);
      // SWR's retry is out.
      fail({ isValidating: true });
      view.rerender(page());
      expect(box().disabled).toBe(true);
      // It answers with equal drafts: the same list, from the newest read.
      hooks.auto = {
        status: "ready",
        list: hooks.auto.list,
        isValidating: false,
      };
      view.rerender(page());
      expect(box().disabled).toBe(false);
    });
  });

  it("a read-only page says why and disables decisions", () => {
    hooks.access = { writable: false, reason: "not_loopback" };
    ready([
      draft({ proposal_id: "x" }),
      draft({ proposal_id: "z", workspace_dir: B }),
    ]);
    const view = render(page());

    expect(
      screen.getByText(
        "This WebUI server listens on the network, not on this machine only, so it doesn't approve or reject drafts. Start it with EvoSci --ui webui, or with npm run dev:local."
      )
    ).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box.disabled).toBe(true);
    for (const run of screen.getAllByRole("button", { name: "Run now" })) {
      expect((run as HTMLButtonElement).disabled).toBe(true);
    }

    // While the access is still being checked nothing is said (no box that
    // goes again a moment later), and every decision waits.
    hooks.access = undefined;
    view.rerender(page());
    expect(
      screen.queryByText("Checking whether this page can review drafts…")
    ).toBeNull();
    expect(screen.queryByText(/listens on the network/)).toBeNull();
    expect(
      (screen.getByRole("checkbox", { name: "Select x" }) as HTMLInputElement)
        .disabled
    ).toBe(true);
    for (const run of screen.getAllByRole("button", { name: "Run now" })) {
      expect((run as HTMLButtonElement).disabled).toBe(true);
    }

    // A selection made while writable keeps its bar, with the decisions off.
    hooks.access = { writable: true };
    view.rerender(page());
    pick("x");
    hooks.access = { writable: false, reason: "not_loopback" };
    view.rerender(page());
    const bar = selection()!;
    for (const name of ["Approve", "Reject"]) {
      expect(
        (within(bar).getByRole("button", { name }) as HTMLButtonElement)
          .disabled
      ).toBe(true);
    }
  });

  it("decisions wait while one is under way", () => {
    ready([draft({ proposal_id: "x" })]);
    const view = render(page());
    pick("x");
    hooks.busy = true;
    view.rerender(page());
    for (const name of ["Approve", "Reject"]) {
      expect(
        (
          within(selection()!).getByRole("button", {
            name,
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
    }
  });

  it("Run now starts that project's run", () => {
    ready([]);
    render(page());
    const group = screen.getByRole("group", { name: "project_B" });
    fireEvent.click(within(group).getByRole("button", { name: "Run now" }));
    expect(hooks.run).toHaveBeenCalledWith(B);
  });

  it("Run now waits while the settings say AutoSkills is off", () => {
    ready([]);
    hooks.settings = { memory_skill_synthesis_enabled: false };
    const view = render(page());
    const run = () =>
      within(screen.getByRole("group", { name: "project_B" })).getByRole(
        "button",
        { name: "Run now" }
      ) as HTMLButtonElement;
    expect(run().disabled).toBe(true);
    // On what holds the button: a disabled one takes no pointer.
    expect(run().title).toBe("");
    expect(run().closest("[title]")?.getAttribute("title")).toBe(
      "AutoSkills is off. Turn it on in Settings first."
    );
    fireEvent.click(run());
    expect(hooks.run).not.toHaveBeenCalled();

    // Settings not known (yet, or an old core): the core says it if off.
    hooks.settings = undefined;
    view.rerender(page());
    expect(run().disabled).toBe(false);
    expect(run().closest("[title]")).toBeNull();
    fireEvent.click(run());
    expect(hooks.run).toHaveBeenCalledWith(B);
  });

  it("Run now is left to the core while an override hides whether AutoSkills is on", () => {
    // Saved off, but EVOSCIENTIST_MEMORY_SKILL_SYNTHESIS_ENABLED decides,
    // and the page isn't told what it says.
    ready([]);
    hooks.settings = { memory_skill_synthesis_enabled: false };
    hooks.sources = {
      memory_skill_synthesis_enabled: { source: "env", shadowed: true },
    };
    const view = render(page());
    const run = () =>
      within(screen.getByRole("group", { name: "project_B" })).getByRole(
        "button",
        { name: "Run now" }
      ) as HTMLButtonElement;
    expect(run().disabled).toBe(false);
    expect(run().closest("[title]")).toBeNull();
    expect(run().getAttribute("aria-describedby")).toBeNull();
    expect(
      screen.queryByText("AutoSkills is off. Turn it on in Settings first.")
    ).toBeNull();
    fireEvent.click(run());
    expect(hooks.run).toHaveBeenCalledWith(B);

    // A source that hides nothing leaves the saved off in charge.
    hooks.sources = {
      memory_skill_synthesis_enabled: { source: "config", shadowed: false },
    };
    view.rerender(page());
    expect(run().disabled).toBe(true);
  });

  it("the status line never states a value an override hides", () => {
    ready([]);
    const BY_ENV =
      "AutoSkills is set by an environment variable on the machine that runs EvoScientist.";
    const env: SettingSource = { source: "env", shadowed: true };

    // Saved on or off: the line says neither.
    hooks.sources = { memory_skill_synthesis_enabled: env };
    const view = render(page());
    expect(screen.getByText(BY_ENV)).toBeTruthy();
    expect(screen.queryByText(/^Every project/)).toBeNull();
    hooks.settings = { memory_skill_synthesis_enabled: false };
    view.rerender(page());
    expect(screen.getByText(BY_ENV)).toBeTruthy();
    expect(screen.queryByText("AutoSkills is off in every project")).toBeNull();

    // Only the mode hidden: the line leaves it out.
    hooks.settings = {
      memory_skill_synthesis_enabled: true,
      memory_skill_synthesis_mode: "auto",
      memory_skill_synthesis_cadence: "weekly",
      memory_skill_synthesis_time: "03:00",
    };
    hooks.sources = { memory_skill_synthesis_mode: env };
    view.rerender(page());
    expect(
      screen.getByText("Every project · runs weekly at 03:00")
    ).toBeTruthy();
    expect(screen.queryByText(/drafts install automatically/)).toBeNull();

    // Mode, cadence and time all hidden: nothing is left to state.
    hooks.sources = {
      memory_skill_synthesis_mode: env,
      memory_skill_synthesis_cadence: env,
      memory_skill_synthesis_time: env,
    };
    view.rerender(page());
    expect(screen.getByText(BY_ENV)).toBeTruthy();
    expect(screen.queryByText(/^Every project/)).toBeNull();
  });

  it("the breadcrumb returns to Research Skills", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ skills: [] }),
        })
      )
    );
    ready([draft({ proposal_id: "x", status: "approved" })]);
    q.values.set("skillsPage", "drafts");
    q.values.set("draftsTab", "approved");
    q.values.set("draftId", "x");
    render(
      <TestProjectsProvider value={mockProjects(readyProjects(A, B))}>
        <RunNow>
          <SkillsMarketplace />
        </RunNow>
      </TestProjectsProvider>
    );
    expect(screen.getByText("Drafted from memory")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Research Skills" }));
    expect(q.writes).toEqual(
      expect.arrayContaining([
        ["skillsPage", null],
        ["draftsTab", null],
        ["draftId", null],
      ])
    );
    expect(
      await screen.findByRole("heading", { name: "Research Skills" })
    ).toBeTruthy();
    expect(screen.queryByText("Drafted from memory")).toBeNull();
  });

  it("the detail pane decides its draft through the gate, with its scope", () => {
    const x = draft({ proposal_id: "x", skill_name: "arxiv-paper-retrieval" });
    const y = draft({ proposal_id: "y", created_at: "2026-10-01T09:00:00Z" });
    // A draft of a project the backend no longer serves.
    const g = draft({
      proposal_id: "g",
      skill_name: "orphan-skill",
      workspace_dir: "/work/gone",
      created_at: "2026-09-01T09:00:00Z",
    });
    ready([x, y, g]);
    q.values.set("draftId", "x");
    const gate = { open: true };
    const gated = { isReady: () => gate.open };
    const view = render(page(readyProjects(A, B), gated));
    // The open draft's pane: the one level-3 heading's box.
    const pane = () =>
      within(screen.getByRole("heading", { level: 3 }).parentElement!);
    const disabled = (name: string) =>
      (pane().getByRole("button", { name }) as HTMLButtonElement).disabled;

    expect(pane().getByText("EvoSci_test")).toBeTruthy();
    fireEvent.click(pane().getByLabelText("Install into"));
    fireEvent.click(
      screen.getByRole("option", { name: "All projects (global)" })
    );
    // The only decision that sends a scope: the one the pane picked.
    fireEvent.click(pane().getByRole("button", { name: "Approve" }));
    expect(hooks.approve.mock.calls).toEqual([[[x], { x: "global" }]]);
    fireEvent.click(pane().getByRole("button", { name: "Reject" }));
    expect(hooks.reject.mock.calls).toEqual([[[x]]]);

    // A read that has just started closes the gate before the render that
    // turns the buttons off.
    gate.open = false;
    fireEvent.click(pane().getByRole("button", { name: "Approve" }));
    fireEvent.click(pane().getByRole("button", { name: "Reject" }));
    expect(hooks.approve).toHaveBeenCalledTimes(1);
    expect(hooks.reject).toHaveBeenCalledTimes(1);

    // While the projects are read again: off.
    view.rerender(
      page(readyProjects(A, B), { refreshing: true, isReady: () => false })
    );
    expect(disabled("Approve")).toBe(true);
    expect(disabled("Reject")).toBe(true);

    // A draft whose project isn't registered: off, and nothing goes.
    gate.open = true;
    q.set("draftId", "g");
    view.rerender(page(readyProjects(A, B), gated));
    expect(disabled("Approve")).toBe(true);
    expect(disabled("Reject")).toBe(true);
    fireEvent.click(pane().getByRole("button", { name: "Approve" }));
    fireEvent.click(pane().getByRole("button", { name: "Reject" }));
    expect(hooks.approve).toHaveBeenCalledTimes(1);
    expect(hooks.reject).toHaveBeenCalledTimes(1);
  });

  it("a decision from the detail pane keeps the focus on the page", () => {
    const x = draft({ proposal_id: "x", skill_name: "arxiv-paper-retrieval" });
    ready([x]);
    q.values.set("draftId", "x");
    const view = render(page());
    const approve = screen.getByRole("button", {
      name: "Approve",
    }) as HTMLButtonElement;
    approve.focus();
    fireEvent.click(approve);
    expect(hooks.approve).toHaveBeenCalledWith([x], { x: "workspace" });

    // Approve turns off while the decision runs. Chrome blurs a button the
    // moment it turns off: a focusout with no new target, the focus on the
    // page. jsdom keeps it focused, so the page's view of the focus is
    // stubbed until something takes it: the focus stays in the pane, on the
    // draft's heading.
    approve.disabled = true;
    fireEvent.focusOut(approve, { relatedTarget: null });
    const real = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "activeElement"
    )!.get!;
    let moved = false;
    const onFocusIn = () => {
      moved = true;
    };
    document.addEventListener("focusin", onFocusIn);
    const active = vi
      .spyOn(document, "activeElement", "get")
      .mockImplementation(() =>
        moved ? (real.call(document) as Element) : document.body
      );
    try {
      hooks.busy = true;
      view.rerender(page());
    } finally {
      active.mockRestore();
      document.removeEventListener("focusin", onFocusIn);
    }
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "arxiv-paper-retrieval" })
    );

    // Approved, it leaves Pending with its pane: the selected tab.
    hooks.busy = false;
    ready([{ ...x, status: "approved" }]);
    view.rerender(page());
    expect(
      screen.queryByRole("heading", { name: "arxiv-paper-retrieval" })
    ).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { selected: true })
    );
  });

  it("a click on the pane's text doesn't pull the focus there later", () => {
    const x = draft({
      proposal_id: "x",
      skill_name: "arxiv-paper-retrieval",
      description: "Find papers on arXiv.",
    });
    ready([x]);
    q.values.set("draftId", "x");
    const view = render(page());
    const pane = () =>
      within(screen.getByRole("heading", { level: 3 }).parentElement!);

    // Plain text takes no focus: the page keeps it.
    fireEvent.click(pane().getByText("Find papers on arXiv."));
    expect(document.activeElement).toBe(document.body);
    // A decision elsewhere turns the pane's buttons off: nothing moves.
    hooks.busy = true;
    view.rerender(page());
    expect(document.activeElement).toBe(document.body);

    // A click on a button counts even where it takes no focus (Safari).
    hooks.busy = false;
    view.rerender(page());
    fireEvent.click(pane().getByRole("button", { name: "Approve" }));
    expect(document.activeElement).toBe(document.body);
    hooks.busy = true;
    view.rerender(page());
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "arxiv-paper-retrieval" })
    );
  });

  it("a draft that leaves the list under its question gives the focus to the selected tab", async () => {
    const u = draft({
      proposal_id: "u",
      skill_name: "paper-review-v2",
      operation: "update",
      target_skill_name: "paper-review",
    });
    const c = draft({ proposal_id: "c", created_at: "2026-10-01T09:00:00Z" });
    ready([u, c]);
    q.values.set("draftId", "u");
    const view = render(page());
    const approve = within(
      screen.getByRole("heading", { level: 3 }).parentElement!
    ).getByRole("button", { name: "Approve" });
    approve.focus();
    fireEvent.click(approve);
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Another decision runs meanwhile (the question's buttons turn off),
    // and u is decided elsewhere before the question closes: its pane and
    // the question go together.
    hooks.busy = true;
    view.rerender(page());
    ready([{ ...u, status: "approved" }, c]);
    view.rerender(page());
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("tab", { selected: true })
      )
    );
  });

  it("drafts decided here leave the selection and wait for the list to catch up", async () => {
    const x = draft({ proposal_id: "x" });
    const y = draft({ proposal_id: "y", created_at: "2026-10-01T09:00:00Z" });
    ready([x, y]);
    hooks.approve.mockResolvedValueOnce({ done: [x], failed: [] });
    const view = render(page());
    pick("x");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    // The answers are in: x leaves the selection at once, though the list
    // (its re-read stalled) still reads it as Pending.
    await waitFor(() => expect(selection()).toBeNull());
    const box = () =>
      screen.getByRole("checkbox", { name: "Select x" }) as HTMLInputElement;
    expect(box().disabled).toBe(true);

    // Nothing can send it again: select-all takes y alone, and the open
    // draft's own buttons are off.
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all drafts in EvoSci_test" })
    );
    expect(selection()?.textContent).toContain("1 selected");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    expect(hooks.approve).toHaveBeenLastCalledWith([y]);
    q.set("draftId", "x");
    view.rerender(page());
    const pane = within(
      screen.getByRole("heading", { level: 3 }).parentElement!
    );
    const approve = pane.getByRole("button", {
      name: "Approve",
    }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(hooks.approve).toHaveBeenCalledTimes(2);

    // The next list takes over: it has x decided, so x leaves Pending.
    ready([{ ...x, status: "approved" }, y]);
    view.rerender(page());
    expect(screen.queryByRole("checkbox", { name: "Select x" })).toBeNull();
  });

  it("a decision another window took back is decidable again with the next list", async () => {
    const x = draft({ proposal_id: "x" });
    ready([x]);
    hooks.approve.mockResolvedValueOnce({ done: [x], failed: [] });
    q.values.set("draftId", "x");
    const view = render(page());
    pick("x");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    const box = () =>
      screen.getByRole("checkbox", { name: "Select x" }) as HTMLInputElement;
    await waitFor(() => expect(box().disabled).toBe(true));
    // Another window's Undo: the next list has x Pending again.
    ready([x]);
    view.rerender(page());
    expect(box().disabled).toBe(false);
    const pane = within(
      screen.getByRole("heading", { level: 3 }).parentElement!
    );
    expect(
      (pane.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it("a draft that changed since the page read it leaves the selection and stays decidable", async () => {
    const x = draft({ proposal_id: "x" });
    const y = draft({ proposal_id: "y", created_at: "2026-10-01T09:00:00Z" });
    ready([x, y]);
    // x goes through; a resubmit rewrote y after the list was read.
    hooks.approve.mockResolvedValueOnce({
      done: [x],
      failed: [
        {
          draft: y,
          message:
            "y changed since the page read it, so nothing was installed. Read the new version, then decide.",
          changed: true,
        },
      ],
    });
    const view = render(page());
    pick("x");
    pick("y");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    const box = (id: string) =>
      screen.getByRole("checkbox", {
        name: `Select ${id}`,
      }) as HTMLInputElement;
    // x waits for the list as decided. y leaves the selection at once, so a
    // second click can't approve its new version unread, but isn't decided:
    // it is still pending.
    await waitFor(() => expect(box("x").disabled).toBe(true));
    expect(selection()).toBeNull();
    expect(box("y").checked).toBe(false);
    expect(box("y").disabled).toBe(false);

    // The re-read lists y's new version: decidable, and that version goes.
    const y2 = { ...y, updated_at: "2026-11-06T11:00:00Z" };
    ready([{ ...x, status: "approved" }, y2]);
    view.rerender(page());
    expect(box("y").disabled).toBe(false);
    pick("y");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    expect(hooks.approve).toHaveBeenLastCalledWith([y2]);
  });

  it("a bulk approve sends each draft as it was picked, so a rewrite since draws draft_changed", async () => {
    // The real decision hook, down to the relay's POST.
    hooks.realActions = true;
    const errors = vi.spyOn(toast, "error");
    toastSpy = errors;
    const x = draft({ proposal_id: "x", updated_at: "2026-11-06T08:00:00Z" });
    const y = draft({
      proposal_id: "y",
      created_at: "2026-10-01T09:00:00Z",
      updated_at: "2026-11-06T09:00:00Z",
    });
    ready([x, y]);
    const view = render(page());
    pick("x");
    pick("y");
    // A run resubmitted y after the pick; the next poll lists the new
    // version, and y stays picked.
    const y2 = { ...y, updated_at: "2026-11-06T10:00:00Z" };
    ready([x, y2]);
    view.rerender(page());
    expect(selection()?.textContent).toContain("2 selected");

    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        const [status, answer] =
          body.proposal_id === "x"
            ? [200, { approved: true, scope: "workspace", operation: "create" }]
            : [409, { error: "draft_changed", updated_at: y2.updated_at }];
        return new Response(JSON.stringify(answer), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    approveSelected();
    await waitFor(() => expect(errors).toHaveBeenCalled());
    expect(bodies).toEqual([
      // Not rewritten: the stamp it was picked at is the listed one.
      {
        action: "approve",
        proposal_id: "x",
        scope: null,
        expected_updated_at: "2026-11-06T08:00:00Z",
      },
      // Rewritten since the pick: the version picked, which the core
      // refuses rather than install the new one unread.
      {
        action: "approve",
        proposal_id: "y",
        scope: null,
        expected_updated_at: "2026-11-06T09:00:00Z",
      },
    ]);
    const node = errors.mock.calls.at(-1)?.[0] as {
      props: { children: Array<{ props: { children: string } }> };
    };
    expect(node.props.children.map((c) => c.props.children)).toEqual([
      "y changed since the page read it, so nothing was installed. Read the new version, then decide.",
    ]);
    // y stays pending, out of the selection and decidable; x waits as
    // decided.
    await waitFor(() => expect(selection()).toBeNull());
    const box = (id: string) =>
      screen.getByRole("checkbox", {
        name: `Select ${id}`,
      }) as HTMLInputElement;
    expect(box("x").disabled).toBe(true);
    expect(box("y").checked).toBe(false);
    expect(box("y").disabled).toBe(false);
  });

  it("a bulk reject sends each draft as it was picked, so a rewrite since draws draft_changed", async () => {
    // The real decision hook, down to the relay's POST.
    hooks.realActions = true;
    const errors = vi.spyOn(toast, "error");
    toastSpy = errors;
    const x = draft({ proposal_id: "x", updated_at: "2026-11-06T08:00:00Z" });
    const y = draft({
      proposal_id: "y",
      created_at: "2026-10-01T09:00:00Z",
      updated_at: "2026-11-06T09:00:00Z",
    });
    ready([x, y]);
    const view = render(page());
    pick("x");
    pick("y");
    // A run resubmitted y after the pick; the next poll lists the new
    // version, and y stays picked.
    const y2 = { ...y, updated_at: "2026-11-06T10:00:00Z" };
    ready([x, y2]);
    view.rerender(page());
    expect(selection()?.textContent).toContain("2 selected");

    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        const [status, answer] =
          body.proposal_id === "x"
            ? [200, { rejected: true }]
            : [409, { error: "draft_changed", updated_at: y2.updated_at }];
        return new Response(JSON.stringify(answer), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Reject" })
    );
    await waitFor(() => expect(errors).toHaveBeenCalled());
    expect(bodies).toEqual([
      // Not rewritten: the stamp it was picked at is the listed one.
      {
        action: "reject",
        proposal_id: "x",
        expected_updated_at: "2026-11-06T08:00:00Z",
      },
      // Rewritten since the pick: the version picked, which the core
      // refuses rather than reject the new one unread.
      {
        action: "reject",
        proposal_id: "y",
        expected_updated_at: "2026-11-06T09:00:00Z",
      },
    ]);
    const node = errors.mock.calls.at(-1)?.[0] as {
      props: { children: Array<{ props: { children: string } }> };
    };
    expect(node.props.children.map((c) => c.props.children)).toEqual([
      "y changed since the page read it, so it wasn't rejected. Read the new version, then decide.",
    ]);
    // y stays pending, out of the selection and decidable; x waits as
    // decided.
    await waitFor(() => expect(selection()).toBeNull());
    const box = (id: string) =>
      screen.getByRole("checkbox", {
        name: `Select ${id}`,
      }) as HTMLInputElement;
    expect(box("x").disabled).toBe(true);
    expect(box("y").checked).toBe(false);
    expect(box("y").disabled).toBe(false);
  });

  it("a bulk decision cut short leaves the drafts not sent selected and decidable", async () => {
    hooks.realActions = true;
    const errors = vi.spyOn(toast, "error");
    toastSpy = errors;
    const x = draft({ proposal_id: "x" });
    const y = draft({ proposal_id: "y", created_at: "2026-10-01T09:00:00Z" });
    const z = draft({ proposal_id: "z", created_at: "2026-09-01T09:00:00Z" });
    ready([x, y, z]);
    render(page());
    pick("x");
    pick("y");
    pick("z");
    // x is rejected; the relay can't reach the backend for y; z never goes.
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { proposal_id: string };
        sent.push(body.proposal_id);
        const [status, answer] =
          body.proposal_id === "x"
            ? [200, { rejected: true }]
            : [502, { error: "backend_unreachable" }];
        return new Response(JSON.stringify(answer), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Reject" })
    );
    await waitFor(() => expect(errors).toHaveBeenCalled());
    expect(sent).toEqual(["x", "y"]);
    const node = errors.mock.calls.at(-1)?.[0] as {
      props: { children: Array<{ props: { children: string } }> };
    };
    expect(node.props.children.map((c) => c.props.children)).toEqual([
      "The WebUI server cannot reach EvoScientist on this machine.",
      "1 more draft was not sent.",
    ]);
    // x waits as decided; y (failed) and z (not sent) stay picked and can
    // be decided again.
    await waitFor(() =>
      expect(selection()?.textContent).toContain("2 selected")
    );
    const box = (id: string) =>
      screen.getByRole("checkbox", {
        name: `Select ${id}`,
      }) as HTMLInputElement;
    expect(box("x").disabled).toBe(true);
    for (const id of ["y", "z"]) {
      expect(box(id).checked).toBe(true);
      expect(box(id).disabled).toBe(false);
    }
  });

  it("the pane's reject sends the version of the draft it shows", async () => {
    hooks.realActions = true;
    const x = draft({ proposal_id: "x", updated_at: "2026-11-06T08:00:00Z" });
    ready([x]);
    q.values.set("draftId", "x");
    render(page());
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ rejected: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const pane = within(
      screen.getByRole("heading", { level: 3 }).parentElement!
    );
    fireEvent.click(pane.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies).toEqual([
      {
        action: "reject",
        proposal_id: "x",
        expected_updated_at: "2026-11-06T08:00:00Z",
      },
    ]);
  });

  it("an update of the project's own copy is approved into the project, with no other place to pick", async () => {
    // The real decision hook, down to the relay's POST.
    hooks.realActions = true;
    const own = "/work/EvoSci_test/skills/paper-review";
    const x = draft({
      proposal_id: "x",
      operation: "update",
      target_skill_name: "paper-review",
      updated_at: "2026-11-06T08:00:00Z",
      install_target: own,
      install_base: own,
    });
    ready([x]);
    q.values.set("draftId", "x");
    render(page());
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            approved: true,
            scope: "workspace",
            operation: "update",
            workspace_shadow: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const pane = within(
      screen.getByRole("heading", { level: 3 }).parentElement!
    );
    expect(pane.queryByRole("combobox")).toBeNull();
    expect(
      pane.getByText(
        "This project has its own paper-review, so the update goes there."
      )
    ).toBeTruthy();
    fireEvent.click(pane.getByRole("button", { name: "Approve" }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Replace an installed skill?" })
      ).getByRole("button", { name: "Replace and install" })
    );
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies).toEqual([
      {
        action: "approve",
        proposal_id: "x",
        scope: "workspace",
        expected_updated_at: "2026-11-06T08:00:00Z",
      },
    ]);
  });

  it("an approval that left the project's own copy in place says the project keeps it", async () => {
    hooks.realActions = true;
    const done = vi.spyOn(toast, "success");
    toastSpy = done;
    const global = "/home/u/.evoscientist/skills/paper-review";
    // An update of the global skill; the project got its own copy since.
    const x = draft({
      proposal_id: "x",
      skill_name: "paper-review",
      operation: "update",
      target_skill_name: "paper-review",
      scope: "global",
      install_target: global,
      install_base: global,
    });
    ready([x]);
    render(page());
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              approved: true,
              scope: "global",
              operation: "update",
              workspace_shadow: "/work/EvoSci_test/skills/paper-review",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );
    pick("paper-review");
    approveSelected();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Replace and install",
      })
    );
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(done.mock.calls).toEqual([
      [
        "Installed paper-review into all projects (global). EvoSci_test keeps its own copy.",
      ],
    ]);
  });

  it("a group's select-all records each draft's stamp", () => {
    const x = draft({ proposal_id: "x", updated_at: "T1-x" });
    const y = draft({
      proposal_id: "y",
      created_at: "2026-10-01T09:00:00Z",
      updated_at: "T1-y",
    });
    ready([x, y]);
    const view = render(page());
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all drafts in EvoSci_test" })
    );
    expect(selection()?.textContent).toContain("2 selected");
    // Both rewritten after the pick.
    const x2 = { ...x, updated_at: "T2-x" };
    const y2 = { ...y, updated_at: "T2-y" };
    ready([x2, y2]);
    view.rerender(page());
    approveSelected();
    expect(hooks.approve.mock.calls).toEqual([
      [
        [
          { ...x2, updated_at: "T1-x" },
          { ...y2, updated_at: "T1-y" },
        ],
      ],
    ]);
  });

  it("a group's select-all keeps the stamp a draft was first picked at", async () => {
    // The real decision hook, down to the relay's POST.
    hooks.realActions = true;
    const x = draft({ proposal_id: "x", updated_at: "T1-x" });
    const y = draft({
      proposal_id: "y",
      created_at: "2026-10-01T09:00:00Z",
      updated_at: "T1-y",
    });
    ready([x, y]);
    const view = render(page());
    pick("y");
    // The list moves y on; select-all then picks x, and y stays as it was
    // first picked.
    ready([x, { ...y, updated_at: "T2-y" }]);
    view.rerender(page());
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all drafts in EvoSci_test" })
    );
    expect(selection()?.textContent).toContain("2 selected");

    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            approved: true,
            scope: "workspace",
            operation: "create",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    approveSelected();
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies.map((b) => [b.proposal_id, b.expected_updated_at])).toEqual([
      ["x", "T1-x"],
      ["y", "T1-y"],
    ]);
  });

  it("the bulk update question's Install sends the version picked", () => {
    const u = draft({
      proposal_id: "u",
      operation: "update",
      target_skill_name: "paper-review",
      updated_at: "T1",
    });
    ready([u]);
    const view = render(page());
    pick("u");
    approveSelected();
    expect(
      screen.getByRole("dialog", { name: "Replace an installed skill?" })
    ).toBeTruthy();
    // The re-read lists u's new version while the question is open.
    const u2 = { ...u, updated_at: "T2" };
    ready([u2]);
    view.rerender(page());
    fireEvent.click(
      screen.getByRole("button", { name: "Replace and install" })
    );
    expect(hooks.approve.mock.calls).toEqual([[[{ ...u2, updated_at: "T1" }]]]);
  });

  it("after a successful Undo a draft waits for the next list, then goes at its new version", async () => {
    const x = draft({ proposal_id: "x" });
    ready([x]);
    hooks.reject.mockResolvedValueOnce({ done: [x], failed: [] });
    const view = render(page());
    pick("x");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Reject" })
    );
    const box = () =>
      screen.getByRole("checkbox", { name: "Select x" }) as HTMLInputElement;
    await waitFor(() => expect(box().disabled).toBe(true));
    // The Undo answered before any list: the revert gave x a new updated_at,
    // so x waits for the list that has it rather than send the old one.
    // Its own re-read is still out.
    act(() => hooks.onReverted?.([x], new Promise<void>(() => {})));
    expect(box().disabled).toBe(true);

    // The Undo's re-read lists x at its new stamp: decidable, and that
    // version goes.
    const x2 = { ...x, updated_at: "2026-11-06T12:00:00Z" };
    ready([x2]);
    view.rerender(page());
    expect(box().disabled).toBe(false);
    pick("x");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    expect(hooks.approve).toHaveBeenLastCalledWith([x2]);
  });

  /** A promise to settle by hand: an Undo's own re-read. */
  function reread() {
    let settle = () => {};
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return { promise, settle };
  }

  it("an Undo's own re-read releases its hold, though SWR keeps the same list object", async () => {
    const x = draft({ proposal_id: "x" });
    ready([x]);
    hooks.reject.mockResolvedValueOnce({ done: [x], failed: [] });
    const view = render(page());
    pick("x");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Reject" })
    );
    const box = () =>
      screen.getByRole("checkbox", { name: "Select x" }) as HTMLInputElement;
    await waitFor(() => expect(box().disabled).toBe(true));
    // The decision's re-read: x rejected.
    ready([{ ...x, status: "rejected" }]);
    view.rerender(page());
    // A poll answered after the core wrote the revert, rendered before the
    // page handles the revert's answer: x pending at its new stamp.
    ready([{ ...x, updated_at: "2026-11-06T12:00:00Z" }]);
    view.rerender(page());
    expect(box().disabled).toBe(false);

    // The revert's answer: x is held until the Undo's own re-read is in.
    const undo = reread();
    act(() => hooks.onReverted?.([x], undo.promise));
    expect(box().disabled).toBe(true);
    // It reads equal data: SWR keeps the cached list object, so no new list
    // comes. Its settling releases the hold.
    await act(async () => undo.settle());
    expect(box().disabled).toBe(false);
  });

  it("an Undo's re-read releases only the holds it made", async () => {
    const x = draft({ proposal_id: "x" });
    ready([x]);
    const view = render(page());
    const box = () =>
      screen.getByRole("checkbox", { name: "Select x" }) as HTMLInputElement;
    const undo = reread();
    act(() => hooks.onReverted?.([x], undo.promise));
    expect(box().disabled).toBe(true);
    // A new list releases it first.
    const x2 = { ...x, updated_at: "2026-11-06T12:00:00Z" };
    ready([x2]);
    view.rerender(page());
    expect(box().disabled).toBe(false);
    // A later decision holds x again.
    hooks.approve.mockResolvedValueOnce({ done: [x2], failed: [] });
    pick("x");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    await waitFor(() => expect(box().disabled).toBe(true));
    // The old Undo's re-read settles late: the newer hold stays.
    await act(async () => undo.settle());
    expect(box().disabled).toBe(true);
  });

  it("an Undo's hold waits while a newer read replaces its own, and goes with that read", async () => {
    const x = draft({ proposal_id: "x" });
    ready([x]);
    hooks.reject.mockResolvedValueOnce({ done: [x], failed: [] });
    const view = render(page());
    pick("x");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Reject" })
    );
    const box = () =>
      screen.getByRole("checkbox", { name: "Select x" }) as HTMLInputElement;
    await waitFor(() => expect(box().disabled).toBe(true));
    // The revert answers before any list landed: the page still renders the
    // pre-Undo list, x pending at its old stamp.
    const undo = reread();
    act(() => hooks.onReverted?.([x], undo.promise));
    // A newer read replaces the Undo's own; SWR discards the replaced one,
    // whose promise still settles, and the newer one is still out.
    hooks.auto = { ...hooks.auto, isValidating: true };
    view.rerender(page());
    await act(async () => undo.settle());
    expect(box().disabled).toBe(true);

    // The newer read commits: x at the revert's stamp, nothing in flight.
    const x2 = { ...x, updated_at: "2026-11-06T12:00:00Z" };
    ready([x2]);
    view.rerender(page());
    expect(box().disabled).toBe(false);
    pick("x");
    fireEvent.click(
      within(selection()!).getByRole("button", { name: "Approve" })
    );
    expect(hooks.approve).toHaveBeenLastCalledWith([x2]);
  });

  it("an Undo's hold goes when the newest read ends, though the list object stays the same", async () => {
    // As in the race above: the list already shows x at the revert's stamp.
    const x = draft({ proposal_id: "x", updated_at: "2026-11-06T12:00:00Z" });
    ready([x]);
    const view = render(page());
    const box = () =>
      screen.getByRole("checkbox", { name: "Select x" }) as HTMLInputElement;
    const undo = reread();
    act(() => hooks.onReverted?.([x], undo.promise));
    hooks.auto = { ...hooks.auto, isValidating: true };
    view.rerender(page());
    await act(async () => undo.settle());
    expect(box().disabled).toBe(true);
    // The newest read ends with equal data: SWR keeps the cached object.
    hooks.auto = { ...hooks.auto, isValidating: false };
    view.rerender(page());
    expect(box().disabled).toBe(false);
  });

  describe("files the page can't show", () => {
    const BIG = 1_100_000;
    /** A draft with files, as [path, size]. */
    const holding = (
      over: Partial<Draft> & { proposal_id: string },
      files: Array<[string, number]>
    ) =>
      draft({
        ...over,
        files: files.map(([path, size]) => ({ path, size, installed: false })),
      });
    /** The core's file route: an answer per path, else the text. */
    function serveFiles(
      answer: (path: string) => Response | Promise<Response> = (path) =>
        new Response(`text of ${path}`)
    ) {
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, _init?: RequestInit) =>
          answer(new URL(String(input)).searchParams.get("path") ?? "")
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }
    const scopeOf = (box: ReturnType<typeof within>) =>
      box.getByLabelText("Install into");
    const fileLines = (dialog: HTMLElement) =>
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent);
    const describedBy = (dialog: HTMLElement) =>
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")
        ?.textContent;

    it("the detail pane checks the files first, busy meanwhile, then asks", async () => {
      let skillMd: (r: Response) => void = () => {};
      serveFiles((path) =>
        path === "SKILL.md"
          ? new Promise<Response>((r) => (skillMd = r))
          : new Response("text")
      );
      const x = holding({ proposal_id: "x", skill_name: "csv-profiler" }, [
        ["SKILL.md", 120],
        ["data/big.csv", BIG],
      ]);
      const y = draft({ proposal_id: "y", created_at: "2026-10-01T09:00:00Z" });
      ready([x, y]);
      q.values.set("draftId", "x");
      render(page());
      pick("y");
      const pane = () =>
        within(screen.getByRole("heading", { level: 3 }).parentElement!);

      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      // Reading SKILL.md: this Approve says so, and no other decision can
      // start.
      const checking = pane().getByRole("button", {
        name: "Checking files…",
      }) as HTMLButtonElement;
      expect(checking.disabled).toBe(true);
      expect(
        (pane().getByRole("button", { name: "Reject" }) as HTMLButtonElement)
          .disabled
      ).toBe(true);
      for (const name of ["Approve", "Reject"]) {
        const button = within(selection()!).getByRole("button", {
          name,
        }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
      }
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(hooks.reject).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();

      // Another draft opened meanwhile ends the check: that draft can be
      // decided at once.
      act(() => q.set("draftId", "y"));
      expect(
        (pane().getByRole("button", { name: "Approve" }) as HTMLButtonElement)
          .disabled
      ).toBe(false);
      // Back on x it reads Approve again: the click was given up when y was
      // opened, and the answer its read gets now asks nothing.
      act(() => q.set("draftId", "x"));
      expect(
        pane().queryByRole("button", { name: "Checking files…" })
      ).toBeNull();
      await act(async () => skillMd(new Response("# skill")));
      expect(
        (pane().getByRole("button", { name: "Approve" }) as HTMLButtonElement)
          .disabled
      ).toBe(false);
      expect(screen.queryByRole("dialog")).toBeNull();

      // A new click reads SKILL.md again (the read that was stopped left
      // nothing behind), then asks.
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      expect(
        pane().getByRole("button", { name: "Checking files…" })
      ).toBeTruthy();
      await act(async () => skillMd(new Response("# skill")));
      const dialog = await screen.findByRole("dialog", {
        name: "Install files you haven't seen?",
      });
      expect(fileLines(dialog)).toEqual([
        "data/big.csv (1.05 MB) — too large to show",
      ]);
      expect(describedBy(dialog)).toContain(
        "csv-profiler holds files this page can't show:"
      );
      expect(hooks.approve).not.toHaveBeenCalled();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Install anyway" })
      );
      expect(hooks.approve.mock.calls).toEqual([[[x], { x: "workspace" }]]);
    });

    it("bulk approve lists every draft's files in one question", async () => {
      const fetchMock = serveFiles((path) => {
        if (path === "logo.png") return new Response("", { status: 415 });
        if (path === "notes.md") return new Response("", { status: 500 });
        return new Response("text");
      });
      const a = holding({ proposal_id: "a", skill_name: "thesis-figure-kit" }, [
        ["SKILL.md", 10],
        ["logo.png", 2048],
      ]);
      const b = holding(
        {
          proposal_id: "b",
          skill_name: "csv-profiler",
          created_at: "2026-10-01T09:00:00Z",
        },
        [
          ["notes.md", 30],
          ["data/big.csv", BIG],
        ]
      );
      const c = draft({ proposal_id: "c", created_at: "2026-09-01T09:00:00Z" });
      ready([a, b, c]);
      render(page());
      pick("thesis-figure-kit");
      pick("csv-profiler");
      pick("c");
      approveSelected();
      const dialog = await screen.findByRole("dialog", {
        name: "Install files you haven't seen?",
      });
      expect(describedBy(dialog)).toBe(
        "Some drafts hold files this page can't show:" +
          "thesis-figure-kitlogo.png — not text" +
          "csv-profilernotes.md — couldn't be checkeddata/big.csv (1.05 MB) — too large to show" +
          "They are installed with their skills."
      );
      expect(dialogWords(dialog).buttons).toEqual(["Cancel", "Install anyway"]);
      // Each file the core would show read once, the large one never.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(hooks.approve).not.toHaveBeenCalled();

      fireEvent.click(
        within(dialog).getByRole("button", { name: "Install anyway" })
      );
      // Exactly what Approve sends: no scopes, each as picked.
      expect(hooks.approve.mock.calls).toEqual([[[a, b, c]]]);
    });

    it("bulk approve reads Checking files… while it reads, and nothing else is decided", async () => {
      const waiting: Array<() => void> = [];
      serveFiles(
        () =>
          new Promise<Response>((r) =>
            waiting.push(() => r(new Response("text")))
          )
      );
      const c = holding({ proposal_id: "c" }, [["SKILL.md", 10]]);
      ready([c]);
      render(page());
      pick("c");
      approveSelected();
      const checking = within(selection()!).getByRole("button", {
        name: "Checking files…",
      }) as HTMLButtonElement;
      expect(checking.disabled).toBe(true);
      const reject = within(selection()!).getByRole("button", {
        name: "Reject",
      }) as HTMLButtonElement;
      expect(reject.disabled).toBe(true);
      fireEvent.click(reject);
      expect(hooks.reject).not.toHaveBeenCalled();

      // Nothing it can't show: a new skill goes without a question.
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(hooks.approve.mock.calls).toEqual([[[c]]]));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        within(selection()!).getByRole("button", { name: "Approve" })
      ).toBeTruthy();
    });

    it("a draft picked while the check reads waits for the next Approve", async () => {
      const waiting: Array<() => void> = [];
      serveFiles(
        () =>
          new Promise<Response>((r) =>
            waiting.push(() => r(new Response("text")))
          )
      );
      const a = holding({ proposal_id: "a", skill_name: "csv-profiler" }, [
        ["SKILL.md", 10],
        ["data/big.csv", BIG],
      ]);
      const b = holding(
        {
          proposal_id: "b",
          skill_name: "lit-map",
          created_at: "2026-10-01T09:00:00Z",
        },
        [["data/huge.csv", BIG]]
      );
      ready([a, b]);
      render(page());
      pick("csv-profiler");
      approveSelected();
      // Picked during the check: its files were never checked.
      pick("lit-map");
      await act(async () => waiting.shift()!());
      const dialog = await screen.findByRole("dialog", {
        name: "Install files you haven't seen?",
      });
      expect(describedBy(dialog)).toBe(
        "csv-profiler holds files this page can't show:" +
          "data/big.csv (1.05 MB) — too large to show" +
          "They are installed with the skill."
      );
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Install anyway" })
      );
      expect(hooks.approve.mock.calls).toEqual([[[a]]]);
      // Still picked, for its own question.
      expect(
        (
          screen.getByRole("checkbox", {
            name: "Select lit-map",
            hidden: true,
          }) as HTMLInputElement
        ).checked
      ).toBe(true);
    });

    it("bulk approve sends the versions picked at the click, though a draft is picked again at a newer one during the check", async () => {
      const waiting: Array<() => void> = [];
      serveFiles(
        () =>
          new Promise<Response>((r) =>
            waiting.push(() => r(new Response("text")))
          )
      );
      const c = holding({ proposal_id: "c" }, [["SKILL.md", 10]]);
      ready([c]);
      const view = render(page());
      pick("c");
      approveSelected();
      // Rewritten while its files are read, then picked again: the pick now
      // records the new version, whose files were never checked.
      const rewritten = { ...c, updated_at: "2026-11-02T09:00:00Z" };
      ready([rewritten]);
      view.rerender(page());
      pick("c");
      pick("c");
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(hooks.approve).toHaveBeenCalled());
      // The version picked at the click: the core answers draft_changed.
      expect(hooks.approve.mock.calls).toEqual([[[c]]]);
    });

    it("the open draft's place can't change while its files are checked", async () => {
      const waiting: Array<() => void> = [];
      serveFiles(
        () =>
          new Promise<Response>((r) =>
            waiting.push(() => r(new Response("text")))
          )
      );
      const x = holding({ proposal_id: "x" }, [["SKILL.md", 10]]);
      ready([x]);
      q.values.set("draftId", "x");
      render(page());
      const pane = () =>
        within(screen.getByRole("heading", { level: 3 }).parentElement!);
      const place = () =>
        pane().getByLabelText("Install into") as HTMLButtonElement;
      expect(place().disabled).toBe(false);
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      expect(place().disabled).toBe(true);
      await act(async () => waiting.shift()!());
      await waitFor(() =>
        expect(hooks.approve.mock.calls).toEqual([[[x], { x: "workspace" }]])
      );
      expect(place().disabled).toBe(false);
    });

    const CHANGED =
      "Nothing was installed: the drafts changed while their files were checked. Approve again.";
    const BUSY = "Another change is still being saved. Approve again.";
    /** Every read waits for the test to answer it. */
    function holdReads() {
      const waiting: Array<() => void> = [];
      serveFiles(
        () =>
          new Promise<Response>((r) =>
            waiting.push(() => r(new Response("text")))
          )
      );
      return waiting;
    }
    const spyErrors = () => {
      const errors = vi.spyOn(toast, "error");
      toastSpy = errors;
      return errors;
    };
    /** Checks that answer only when told, whatever stops them (nothing the
     *  page can't show): each with what stops it. */
    function ownChecks() {
      const checks: Array<{ stop?: AbortSignal; answer: () => void }> = [];
      hooks.check = (_drafts, stop) =>
        new Promise((resolve) =>
          checks.push({ stop, answer: () => resolve(new Map()) })
        );
      return checks;
    }

    it("an approval checked while another change is being saved sends nothing, and says so", async () => {
      const errors = spyErrors();
      const waiting = holdReads();
      const c = holding({ proposal_id: "c" }, [["SKILL.md", 10]]);
      const x = holding(
        { proposal_id: "x", created_at: "2026-10-01T09:00:00Z" },
        [["SKILL.md", 10]]
      );
      ready([c, x]);
      q.values.set("draftId", "x");
      const view = render(page());
      const pane = () =>
        within(screen.getByRole("heading", { level: 3 }).parentElement!);

      // The bar: an Undo clicked on an earlier toast is in flight when the
      // check answers.
      pick("c");
      approveSelected();
      hooks.busy = true;
      view.rerender(page());
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(errors).toHaveBeenCalledWith(BUSY));
      expect(errors).toHaveBeenCalledTimes(1);
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      // The check is over: Approve is back, and usable once the Undo is.
      expect(
        within(selection()!).queryByRole("button", { name: "Checking files…" })
      ).toBeNull();
      hooks.busy = false;
      view.rerender(page());
      expect(
        (
          within(selection()!).getByRole("button", {
            name: "Approve",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false);

      // The pane: the same.
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      hooks.busy = true;
      view.rerender(page());
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
      expect(errors).toHaveBeenLastCalledWith(BUSY);
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(
        pane().queryByRole("button", { name: "Checking files…" })
      ).toBeNull();
    });

    it("a draft unticked while the files are checked doesn't go, silently; the rest go as picked at the click", async () => {
      const errors = spyErrors();
      const waiting = holdReads();
      const a = holding({ proposal_id: "a" }, [["SKILL.md", 10]]);
      const b = holding(
        { proposal_id: "b", created_at: "2026-10-15T09:00:00Z" },
        [["SKILL.md", 10]]
      );
      const c = holding(
        { proposal_id: "c", created_at: "2026-10-01T09:00:00Z" },
        [["SKILL.md", 10]]
      );
      ready([a, b, c]);
      const view = render(page());

      // b unticked during the check; a unticked and ticked again after a
      // rewrite: it goes at the version of the click.
      pick("a");
      pick("b");
      approveSelected();
      pick("b");
      const rewritten = { ...a, updated_at: "2026-11-02T09:00:00Z" };
      ready([rewritten, b, c]);
      view.rerender(page());
      pick("a");
      pick("a");
      await act(async () => {
        while (waiting.length > 0) waiting.shift()!();
      });
      await waitFor(() => expect(hooks.approve).toHaveBeenCalled());
      expect(hooks.approve.mock.calls).toEqual([[[a]]]);
      expect(errors).not.toHaveBeenCalled();

      // Every draft unticked (Clear) during the check: nothing goes, and
      // nothing is said.
      hooks.approve.mockClear();
      const clear = () =>
        fireEvent.click(
          within(selection()!).getByRole("button", { name: "Clear" })
        );
      clear();
      pick("c");
      approveSelected();
      clear();
      await act(async () => {
        while (waiting.length > 0) waiting.shift()!();
      });
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Checking files…" })
        ).toBeNull()
      );
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    });

    it("leaving the open draft or the tab while its files are checked gives the click up for good, though they come back", async () => {
      const errors = spyErrors();
      // Leaving stops the check; these answer all the same, and the page
      // must drop what they say.
      const checks = ownChecks();
      const [x1, x2, x3] = ["x1", "x2", "x3"].map((id, i) =>
        holding(
          {
            proposal_id: id,
            scope: "workspace",
            created_at: `2026-10-0${i + 1}T09:00:00Z`,
          },
          [["SKILL.md", 10]]
        )
      );
      const y = holding(
        { proposal_id: "y", created_at: "2026-09-01T09:00:00Z" },
        [["SKILL.md", 10]]
      );
      ready([x1, x2, x3, y]);
      q.values.set("draftId", "x1");
      const view = render(page());
      const pane = () =>
        within(screen.getByRole("heading", { level: 3 }).parentElement!);
      const place = () => pane().getByLabelText("Install into");
      /** The check left behind: stopped, and "Checking files…" gone. */
      const leftCheck = () => {
        const check = checks.shift()!;
        expect(check.stop?.aborted).toBe(true);
        expect(
          screen.queryByRole("button", { name: "Checking files…" })
        ).toBeNull();
        return check;
      };
      // The check answers with an Undo in flight: what the page would say
      // then isn't said for a click given up.
      const answerWhileBusy = async () => {
        const check = leftCheck();
        hooks.busy = true;
        view.rerender(page());
        await act(async () => check.answer());
        hooks.busy = false;
        view.rerender(page());
      };

      // Clicked into all projects; y shown, then x1 again, at its own place.
      fireEvent.click(place());
      fireEvent.click(
        screen.getByRole("option", { name: "All projects (global)" })
      );
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      act(() => q.set("draftId", "y"));
      act(() => q.set("draftId", "x1"));
      expect(place().textContent).toBe("EvoSci_test/skills (this project)");
      await answerWhileBusy();

      // Another tab, then Pending again, with x2 open.
      act(() => q.set("draftId", "x2"));
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      fireEvent.click(screen.getByRole("tab", { name: /^Approved/ }));
      fireEvent.click(screen.getByRole("tab", { name: /^Pending/ }));
      await answerWhileBusy();

      // Without an Undo in flight too.
      act(() => q.set("draftId", "x3"));
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      act(() => q.set("draftId", "y"));
      act(() => q.set("draftId", "x3"));
      const last = leftCheck();
      await act(async () => last.answer());

      expect(checks).toEqual([]);
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    });

    it("leaving the open draft stops its file check: its reads end, every decision is back at once, and a return shows Approve", async () => {
      const errors = spyErrors();
      const waiting: Array<() => void> = [];
      const fetchMock = serveFiles(
        () =>
          new Promise<Response>((r) =>
            waiting.push(() => r(new Response("text")))
          )
      );
      const [x, y, w] = ["x", "y", "w"].map((id, i) =>
        holding(
          { proposal_id: id, created_at: `2026-10-0${i + 1}T09:00:00Z` },
          [["SKILL.md", 10]]
        )
      );
      const z = draft({ proposal_id: "z", created_at: "2026-09-01T09:00:00Z" });
      ready([x, y, w, z]);
      q.values.set("draftId", "x");
      render(page());
      pick("z");
      const pane = () =>
        within(screen.getByRole("heading", { level: 3 }).parentElement!);
      const stopped = (call: number) =>
        (fetchMock.mock.calls[call][1]?.signal as AbortSignal).aborted;
      const usable = (box: ReturnType<typeof within>) =>
        ["Approve", "Reject"].map(
          (name) =>
            !(box.getByRole("button", { name }) as HTMLButtonElement).disabled
        );
      const checkingNow = () =>
        screen.queryByRole("button", { name: "Checking files…" });

      // Another draft opened: it can be decided at once, and so can the
      // selection; x's read is stopped.
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      expect(checkingNow()).toBeTruthy();
      expect(stopped(0)).toBe(false);
      act(() => q.set("draftId", "y"));
      expect(checkingNow()).toBeNull();
      expect(usable(pane())).toEqual([true, true]);
      expect(usable(within(selection()!))).toEqual([true, true]);
      expect(stopped(0)).toBe(true);

      // Back on x: Approve, not "Checking files…". The read that was
      // stopped answers late, to nobody.
      act(() => q.set("draftId", "x"));
      expect(checkingNow()).toBeNull();
      expect(usable(pane())).toEqual([true, true]);
      await act(async () => waiting.shift()!());
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();

      // A new click reads the file again (the stopped read left nothing
      // behind), and goes.
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(stopped(1)).toBe(false);
      await act(async () => waiting.shift()!());
      await waitFor(() =>
        expect(hooks.approve.mock.calls).toEqual([[[x], { x: "workspace" }]])
      );
      hooks.approve.mockClear();

      // The pane closed.
      act(() => q.set("draftId", "y"));
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      expect(checkingNow()).toBeTruthy();
      act(() => q.set("draftId", null));
      expect(usable(within(selection()!))).toEqual([true, true]);
      expect(stopped(2)).toBe(true);

      // Another tab shown.
      act(() => q.set("draftId", "w"));
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      expect(checkingNow()).toBeTruthy();
      fireEvent.click(screen.getByRole("tab", { name: /^Approved/ }));
      expect(stopped(3)).toBe(true);
      fireEvent.click(screen.getByRole("tab", { name: /^Pending/ }));
      expect(checkingNow()).toBeNull();
      expect(usable(pane())).toEqual([true, true]);

      await act(async () => {
        while (waiting.length > 0) waiting.shift()!();
      });
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    });

    it("the bar's check goes on while drafts are opened and closed", async () => {
      const waiting: Array<() => void> = [];
      const fetchMock = serveFiles(
        () =>
          new Promise<Response>((r) =>
            waiting.push(() => r(new Response("text")))
          )
      );
      const c = holding({ proposal_id: "c" }, [["SKILL.md", 10]]);
      const x = draft({ proposal_id: "x", created_at: "2026-10-01T09:00:00Z" });
      const y = draft({ proposal_id: "y", created_at: "2026-09-01T09:00:00Z" });
      ready([c, x, y]);
      render(page());
      pick("c");
      approveSelected();
      for (const id of ["x", "y", null]) {
        act(() => q.set("draftId", id));
        expect(
          within(selection()!).getByRole("button", { name: "Checking files…" })
        ).toBeTruthy();
      }
      expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(
        false
      );
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(hooks.approve.mock.calls).toEqual([[[c]]]));
    });

    it("a check of a backend left and come back to is given up for good", async () => {
      const errors = spyErrors();
      holdReads();
      const c = holding({ proposal_id: "c" }, [["SKILL.md", 10]]);
      ready([c]);
      const view = render(page());
      pick("c");
      approveSelected();
      // To another backend and straight back, before the check's reads
      // have taken in their abort.
      hooks.deployment = {
        deploymentUrl: "http://127.0.0.1:7001",
        apiKey: "",
      };
      view.rerender(page());
      hooks.deployment = { deploymentUrl: URL_, apiKey: "" };
      view.rerender(page());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(
        within(selection()!).getByRole("button", { name: "Approve" })
      ).toBeTruthy();
    });

    it("a check that answers once the page has gone sends nothing", async () => {
      // A check that answers only when told, whatever stops it: the page
      // must drop the answer itself.
      let answer: (found: Map<string, unknown>) => void = () => {};
      hooks.check = () =>
        new Promise<Map<string, unknown>>((r) => (answer = r));
      const c = draft({ proposal_id: "c" });
      ready([c]);
      const view = render(page());
      pick("c");
      approveSelected();
      view.unmount();
      await act(async () => answer(new Map()));
      expect(hooks.approve).not.toHaveBeenCalled();
    });

    it("a check started for a new backend before the old one's cleanup runs goes to its end", async () => {
      const waiting = holdReads();
      const c = holding({ proposal_id: "c" }, [["SKILL.md", 10]]);
      ready([c]);
      // Clicks Approve in the commit that switches the backend: after the
      // DOM has the new page, before the old backend's effects are cleaned
      // up.
      function ApproveInCommit({ armed }: { armed: boolean }) {
        useLayoutEffect(() => {
          if (!armed) return;
          within(selection()!).getByRole("button", { name: "Approve" }).click();
        }, [armed]);
        return null;
      }
      const view = render(
        page(undefined, undefined, <ApproveInCommit armed={false} />)
      );
      pick("c");
      hooks.deployment = {
        deploymentUrl: "http://127.0.0.1:7001",
        apiKey: "",
      };
      view.rerender(page(undefined, undefined, <ApproveInCommit armed />));
      expect(
        within(selection()!).getByRole("button", { name: "Checking files…" })
      ).toBeTruthy();
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(hooks.approve.mock.calls).toEqual([[[c]]]));
      expect(
        within(selection()!).queryByRole("button", {
          name: "Checking files…",
        })
      ).toBeNull();
    });

    it("a draft unticked while the files are checked is neither asked about nor sent", async () => {
      const waiting = holdReads();
      const u = holding(
        {
          proposal_id: "u",
          skill_name: "paper-review-v2",
          operation: "update",
          target_skill_name: "paper-review",
        },
        [["SKILL.md", 10]]
      );
      const b = holding(
        {
          proposal_id: "b",
          skill_name: "csv-profiler",
          created_at: "2026-10-01T09:00:00Z",
        },
        [["data/big.csv", BIG]]
      );
      ready([u, b]);
      render(page());
      pick("paper-review-v2");
      pick("csv-profiler");
      approveSelected();
      pick("csv-profiler");
      await act(async () => waiting.shift()!());
      const dialog = await screen.findByRole("dialog", {
        name: "Replace an installed skill?",
      });
      // Only u's question: b and its large file are out.
      expect(describedBy(dialog)).toBe(
        "This replaces the installed paper-review."
      );
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Replace and install" })
      );
      expect(hooks.approve.mock.calls).toEqual([[[u]]]);
    });

    it("leaving the open draft while its files are checked cancels its approval, silently", async () => {
      const errors = spyErrors();
      // Leaving stops the check; these answer all the same.
      const checks = ownChecks();
      const x = holding({ proposal_id: "x" }, [["SKILL.md", 10]]);
      const y = holding(
        { proposal_id: "y", created_at: "2026-10-01T09:00:00Z" },
        [["SKILL.md", 10]]
      );
      const z = holding(
        { proposal_id: "z", created_at: "2026-09-01T09:00:00Z" },
        [["SKILL.md", 10]]
      );
      ready([x, y, z]);
      q.values.set("draftId", "x");
      const view = render(page());
      const pane = () =>
        within(screen.getByRole("heading", { level: 3 }).parentElement!);
      // Each time the check left behind is stopped, and answers with an
      // Undo in flight: what the page would say then isn't said for a draft
      // the user left.
      const answerWhileBusy = async () => {
        const check = checks.shift()!;
        expect(check.stop?.aborted).toBe(true);
        expect(
          screen.queryByRole("button", { name: "Checking files…" })
        ).toBeNull();
        hooks.busy = true;
        view.rerender(page());
        await act(async () => check.answer());
        hooks.busy = false;
        view.rerender(page());
      };

      // Another draft opened.
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      act(() => q.set("draftId", "y"));
      await answerWhileBusy();

      // The pane closed.
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      act(() => q.set("draftId", null));
      await answerWhileBusy();

      // Another tab shown.
      act(() => q.set("draftId", "z"));
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      fireEvent.click(screen.getByRole("tab", { name: /^Approved/ }));
      await answerWhileBusy();

      expect(hooks.approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    });

    it("an approval whose files are checked while the drafts can't be read again sends nothing, and says that", async () => {
      const STALE =
        "Nothing was installed: the drafts couldn't be read again. Approve again once they are.";
      const errors = spyErrors();
      const waiting = holdReads();
      const c = holding({ proposal_id: "c" }, [["SKILL.md", 10]]);
      const x = holding(
        { proposal_id: "x", created_at: "2026-10-01T09:00:00Z" },
        [["SKILL.md", 10]]
      );
      const drafts = listOf([c, x]);
      const stale = { status: "error", error: new Error("500"), list: drafts };
      hooks.auto = { status: "ready", list: drafts };
      q.values.set("draftId", "x");
      const view = render(page());
      const pane = () =>
        within(screen.getByRole("heading", { level: 3 }).parentElement!);

      // The bar: the drafts didn't change, only their re-read failed.
      pick("c");
      approveSelected();
      hooks.auto = stale;
      view.rerender(page());
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(errors).toHaveBeenCalledWith(STALE));
      expect(errors).toHaveBeenCalledTimes(1);
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();

      // The pane: the same.
      hooks.auto = { status: "ready", list: drafts };
      view.rerender(page());
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      hooks.auto = stale;
      view.rerender(page());
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
      expect(errors).toHaveBeenLastCalledWith(STALE);
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();

      // Once they are read again, "Approve again" goes: c is still picked,
      // and its file was read by the first check.
      hooks.auto = { status: "ready", list: drafts };
      view.rerender(page());
      approveSelected();
      expect(hooks.approve.mock.calls).toEqual([[[c]]]);
    });

    // Both can hold when a check ends: an Undo out, and a re-read of the
    // drafts that failed. What is being saved reads the drafts again when it
    // ends, so that is what the click is told to wait for.
    it("with another change being saved and the drafts unread at once, it says the change is being saved", async () => {
      const STALE =
        "Nothing was installed: the drafts couldn't be read again. Approve again once they are.";
      const errors = spyErrors();
      const waiting = holdReads();
      const c = holding({ proposal_id: "c" }, [["SKILL.md", 10]]);
      const x = holding(
        { proposal_id: "x", created_at: "2026-10-01T09:00:00Z" },
        [["SKILL.md", 10]]
      );
      const drafts = listOf([c, x]);
      const fresh = { status: "ready", list: drafts };
      const stale = { status: "error", error: new Error("500"), list: drafts };
      hooks.auto = fresh;
      q.values.set("draftId", "x");
      const view = render(page());
      const pane = () =>
        within(screen.getByRole("heading", { level: 3 }).parentElement!);

      // The bar.
      pick("c");
      approveSelected();
      hooks.busy = true;
      hooks.auto = stale;
      view.rerender(page());
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
      expect(errors).toHaveBeenLastCalledWith(BUSY);
      expect(hooks.approve).not.toHaveBeenCalled();

      // The pane: the same.
      hooks.busy = false;
      hooks.auto = fresh;
      view.rerender(page());
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      hooks.busy = true;
      hooks.auto = stale;
      view.rerender(page());
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
      expect(errors).toHaveBeenLastCalledWith(BUSY);
      expect(errors).not.toHaveBeenCalledWith(STALE);
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("an approval whose drafts changed while their files were checked sends nothing, and says so", async () => {
      const errors = spyErrors();
      const waiting = holdReads();
      const c = holding({ proposal_id: "c" }, [["SKILL.md", 10]]);
      const d = holding(
        { proposal_id: "d", created_at: "2026-10-15T09:00:00Z" },
        [["SKILL.md", 10]]
      );
      const x = holding(
        { proposal_id: "x", created_at: "2026-10-01T09:00:00Z" },
        [["SKILL.md", 10]]
      );
      ready([c, d, x]);
      const gate = { open: true };
      const gated = { isReady: () => gate.open };
      const view = render(page(readyProjects(A, B), gated));
      const pane = () =>
        within(screen.getByRole("heading", { level: 3 }).parentElement!);

      // Every draft of the approval decided elsewhere meanwhile.
      pick("c");
      approveSelected();
      ready([{ ...c, status: "approved" }, d, x]);
      view.rerender(page(readyProjects(A, B), gated));
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(errors).toHaveBeenCalledWith(CHANGED));
      expect(hooks.approve).not.toHaveBeenCalled();

      // The projects' gate closed when the check answered.
      pick("d");
      approveSelected();
      gate.open = false;
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
      expect(errors).toHaveBeenLastCalledWith(CHANGED);
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      gate.open = true;

      // The open draft rewritten while its files were checked.
      act(() => q.set("draftId", "x"));
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      ready([
        { ...c, status: "approved" },
        d,
        { ...x, updated_at: "2026-11-02T09:00:00Z" },
      ]);
      view.rerender(page(readyProjects(A, B), gated));
      await act(async () => waiting.shift()!());
      await waitFor(() => expect(errors).toHaveBeenCalledTimes(3));
      expect(errors).toHaveBeenLastCalledWith(CHANGED);
      expect(hooks.approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        (pane().getByRole("button", { name: "Approve" }) as HTMLButtonElement)
          .disabled
      ).toBe(false);
    });

    it("a check that hears nothing gives up after 20 s and asks about every file it couldn't check", async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = serveFiles(() => new Promise<Response>(() => {}));
        const paths = Array.from({ length: 32 }, (_, i) => `f${i}.md`);
        const c = holding(
          { proposal_id: "c", skill_name: "csv-profiler" },
          paths.map((p) => [p, 3])
        );
        ready([c]);
        render(page());
        pick("csv-profiler");
        approveSelected();
        expect(
          within(selection()!).getByRole("button", {
            name: "Checking files…",
          })
        ).toBeTruthy();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(CHECK_DEADLINE_MS - 10);
        });
        expect(screen.queryByRole("dialog")).toBeNull();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20);
        });
        const dialog = screen.getByRole("dialog", {
          name: "Install files you haven't seen?",
        });
        expect(fileLines(dialog)).toEqual(
          paths.map((p) => `${p} — couldn't be checked`)
        );
        // Four reads, then four more at 15 s; none after the deadline.
        expect(fetchMock).toHaveBeenCalledTimes(8);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(8);
        expect(hooks.approve).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a deployment switch drops the check: Checking files… goes, its reads stop, and nothing is sent", async () => {
      const errors = spyErrors();
      const waiting: Array<() => void> = [];
      const fetchMock = serveFiles(
        () =>
          new Promise<Response>((r) =>
            waiting.push(() => r(new Response("text")))
          )
      );
      const c = holding({ proposal_id: "c" }, [["SKILL.md", 10]]);
      const x = holding(
        { proposal_id: "x", created_at: "2026-10-01T09:00:00Z" },
        [["SKILL.md", 10]]
      );
      ready([c, x]);
      q.values.set("draftId", "x");
      const view = render(page());
      const pane = () =>
        within(screen.getByRole("heading", { level: 3 }).parentElement!);
      const enabled = (el: HTMLElement) => !(el as HTMLButtonElement).disabled;

      // The bar's check, then another backend.
      pick("c");
      approveSelected();
      expect(
        within(selection()!).getByRole("button", { name: "Checking files…" })
      ).toBeTruthy();
      hooks.deployment = {
        deploymentUrl: "http://127.0.0.1:7001",
        apiKey: "",
      };
      view.rerender(page());
      expect(
        enabled(within(selection()!).getByRole("button", { name: "Approve" }))
      ).toBe(true);
      expect(enabled(pane().getByRole("button", { name: "Approve" }))).toBe(
        true
      );
      await waitFor(() =>
        expect(
          (fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted
        ).toBe(true)
      );
      await act(async () => waiting.shift()!());

      // The pane's check, then the same address with another key.
      fireEvent.click(pane().getByRole("button", { name: "Approve" }));
      expect(
        pane().getByRole("button", { name: "Checking files…" })
      ).toBeTruthy();
      hooks.deployment = {
        deploymentUrl: "http://127.0.0.1:7001",
        apiKey: "k-2",
      };
      view.rerender(page());
      expect(enabled(pane().getByRole("button", { name: "Approve" }))).toBe(
        true
      );
      expect(enabled(scopeOf(pane()))).toBe(true);
      await act(async () => waiting.shift()!());

      expect(hooks.approve).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    });

    it("an update whose files can all be shown asks only its own question", async () => {
      serveFiles();
      const u = holding(
        {
          proposal_id: "u",
          operation: "update",
          target_skill_name: "paper-review",
        },
        [["SKILL.md", 10]]
      );
      ready([u]);
      render(page());
      pick("u");
      approveSelected();
      const dialog = await screen.findByRole("dialog", {
        name: "Replace an installed skill?",
      });
      expect(within(dialog).queryByRole("list")).toBeNull();
      expect(dialogWords(dialog).description).toBe(
        "This replaces the installed paper-review."
      );
    });

    it("an update with a file it can't show adds the files to its question", async () => {
      serveFiles();
      const u = holding(
        {
          proposal_id: "u",
          skill_name: "paper-review-v2",
          operation: "update",
          target_skill_name: "paper-review",
        },
        [
          ["SKILL.md", 10],
          ["model.bin", BIG],
        ]
      );
      ready([u]);
      render(page());
      pick("paper-review-v2");
      approveSelected();
      const dialog = await screen.findByRole("dialog", {
        name: "Replace an installed skill?",
      });
      expect(describedBy(dialog)).toBe(
        "This replaces the installed paper-review." +
          "paper-review-v2 holds files this page can't show:" +
          "model.bin (1.05 MB) — too large to show" +
          "They are installed with the skill."
      );
      expect(dialogWords(dialog).buttons).toEqual([
        "Cancel",
        "Replace and install",
      ]);
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Replace and install" })
      );
      expect(hooks.approve.mock.calls).toEqual([[[u]]]);
    });

    it("reads the draft's current files and installs the version picked", () => {
      const fetchMock = serveFiles();
      const c = draft({ proposal_id: "c" });
      ready([c]);
      const view = render(page());
      pick("c");
      // Rewritten after it was picked: now with a large file.
      const rewritten = holding(
        { proposal_id: "c", updated_at: "2026-11-02T09:00:00Z" },
        [["data/big.csv", BIG]]
      );
      ready([rewritten]);
      view.rerender(page());
      approveSelected();
      // Known by its size: asked at once, nothing read.
      const dialog = screen.getByRole("dialog", {
        name: "Install files you haven't seen?",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Install anyway" })
      );
      // The stamp recorded at the pick: the core answers draft_changed.
      expect(hooks.approve.mock.calls).toEqual([
        [[{ ...rewritten, updated_at: c.updated_at }]],
      ]);
    });

    it("the files question keeps its words while it fades out", async () => {
      animateDialogs();
      serveFiles();
      const c = holding({ proposal_id: "c", skill_name: "csv-profiler" }, [
        ["data/big.csv", BIG],
      ]);
      ready([c]);
      render(page());
      pick("csv-profiler");
      approveSelected();
      const dialog = screen.getByRole("dialog", {
        name: "Install files you haven't seen?",
      });
      const asked = dialogWords(dialog);
      expect(asked.description).toBe(
        "csv-profiler holds files this page can't show:" +
          "data/big.csv (1.05 MB) — too large to show" +
          "They are installed with the skill."
      );

      // The decision's answers empty the selection while it fades out.
      hooks.approve.mockResolvedValueOnce({ done: [c], failed: [] });
      const confirm = within(dialog).getByRole("button", {
        name: "Install anyway",
      });
      fireEvent.click(confirm);
      await waitFor(() =>
        expect(
          screen.queryByRole("region", { name: "Selection", hidden: true })
        ).toBeNull()
      );
      expect(dialog.isConnected).toBe(true);
      expect(dialog.getAttribute("data-state")).toBe("closed");
      expect(dialogWords(dialog)).toEqual(asked);
      fireEvent.click(confirm);
      expect(hooks.approve).toHaveBeenCalledTimes(1);
    });
  });

  it("opening the page marks automatic installs seen", () => {
    ready([]);
    const before = Date.now();
    const view = render(page());
    expect(hooks.mark).toHaveBeenCalledTimes(1);
    const [url, at] = hooks.mark.mock.calls[0];
    expect(url).toBe(URL_);
    expect(new Date(at).toISOString()).toBe(at);
    expect(Date.parse(at)).toBeGreaterThanOrEqual(before - 1000);

    // Not on every render.
    ready([draft({ proposal_id: "x" })]);
    view.rerender(page());
    fireEvent.click(screen.getByRole("tab", { name: /^Approved/ }));
    expect(hooks.mark).toHaveBeenCalledTimes(1);
  });
});
