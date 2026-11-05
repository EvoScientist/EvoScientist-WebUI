// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft, DraftList } from "@/lib/autoskills";
import type { ProjectsState } from "@/lib/projects";
import type { ProjectsContextValue } from "@/providers/ProjectsProvider";
import type { SettingsWriteAccess } from "@/lib/settings";
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
  approve: vi.fn(async (_drafts: Draft[], _scopes?: unknown) => ({})),
  reject: vi.fn(async (_drafts: Draft[]) => ({})),
  busy: false,
  running: new Set<string>() as ReadonlySet<string>,
  run: vi.fn(async (_key: string) => undefined),
  settings: undefined as Record<string, unknown> | undefined,
  access: undefined as SettingsWriteAccess | undefined,
}));

vi.mock("@/app/hooks/useAutoSkills", () => ({
  useAutoSkills: () => ({ ...hooks.auto, refresh: hooks.refresh }),
  markAutoSeen: hooks.mark,
}));
vi.mock("@/app/hooks/useDraftActions", () => ({
  useDraftActions: () => ({
    approve: hooks.approve,
    reject: hooks.reject,
    busy: hooks.busy,
  }),
}));
vi.mock("@/app/hooks/useSettings", () => ({
  useSettings: () => ({
    payload: hooks.settings ? { settings: hooks.settings } : undefined,
  }),
  useSettingsAccess: () => ({ access: hooks.access, refresh: vi.fn() }),
}));
vi.mock("@/providers/ClientProvider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDeployment: () => ({ deploymentUrl: URL_, apiKey: "" }),
}));
vi.mock("@/app/components/SkillDetailDialog", () => ({
  SkillDetailDialog: () => null,
}));

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
  over: Partial<ProjectsContextValue> = {}
) {
  return (
    <TestProjectsProvider value={{ ...mockProjects(projects), ...over }}>
      <RunNow>
        <DraftsPage />
      </RunNow>
    </TestProjectsProvider>
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
  hooks.access = { writable: true };
});
// Restored here, so a failing assertion can't leak them into other tests.
let focusSpy: { mockRestore(): void } | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  focusSpy?.mockRestore();
  focusSpy = undefined;
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
