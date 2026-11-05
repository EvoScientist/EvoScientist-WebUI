// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Draft, DraftGroup, DraftStatus } from "@/lib/autoskills";
import { formatTime } from "@/lib/time";
import { RunNowContext } from "@/providers/runNowContext";
import { DraftList } from "./DraftList";

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

const x = draft({
  proposal_id: "x",
  skill_name: "arxiv-paper-retrieval",
  description: "Find and fetch arXiv papers by topic.",
  created_at: "2026-11-01T09:00:00Z",
});
const y = draft({
  proposal_id: "y",
  skill_name: "chunk-verifier",
  operation: "update",
  target_skill_name: "chunk-verifier",
  created_at: "2026-10-20T09:00:00Z",
});
const z = draft({ proposal_id: "z", skill_name: "lit-map", workspace_dir: B });

function twoProjects(
  over: { a?: Draft[]; b?: Draft[]; bMissing?: boolean } = {}
): DraftGroup[] {
  return [
    {
      project: { key: A, name: "EvoSci_test", missing: false },
      label: "EvoSci_test",
      drafts: over.a ?? [x, y],
    },
    {
      project: { key: B, name: "project_B", missing: over.bMissing ?? false },
      label: "project_B",
      drafts: over.b ?? [z],
    },
  ];
}

const GONE = "/work/gone";

function renderList(
  over: Partial<{
    groups: DraftGroup[];
    status: DraftStatus;
    selected: ReadonlySet<string>;
    openId: string | null;
    /** The projects whose run the page follows (Run now's context). */
    running: ReadonlySet<string>;
    canWrite: boolean;
    registered: ReadonlySet<string> | null;
  }> = {}
) {
  const { running = new Set<string>(), ...rest } = over;
  const props = {
    groups: twoProjects(),
    status: "pending" as DraftStatus,
    selected: new Set<string>(),
    onToggle: vi.fn(),
    openId: null,
    onOpen: vi.fn(),
    onRun: vi.fn(),
    canWrite: true,
    registered: new Set([A, B, GONE]) as ReadonlySet<string> | null,
    ...rest,
  };
  const runNow = { running, run: vi.fn(async () => undefined) };
  const { rerender } = render(<DraftList {...props} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <RunNowContext.Provider value={runNow}>{children}</RunNowContext.Provider>
    ),
  });
  return { props, rerender };
}

const group = (label: string) => screen.getByRole("group", { name: label });

/** A row button's accessible name: the element its aria-labelledby names. */
const nameOf = (button: HTMLElement) =>
  document.getElementById(button.getAttribute("aria-labelledby") ?? "")
    ?.textContent;

describe("DraftList", () => {
  it("groups drafts by project with counts and Run now", () => {
    const { props } = renderList({
      groups: twoProjects({ b: [] }).concat({
        project: { key: GONE, name: "gone", missing: true },
        label: "gone",
        drafts: [],
      }),
    });

    const a = group("EvoSci_test");
    const toggle = within(a).getByRole("button", { name: /EvoSci_test/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("2");
    // Newest first, as the groups come.
    const rows = within(a).getAllByRole("listitem");
    expect(rows.map((r) => nameOf(within(r).getByRole("button")))).toEqual([
      "arxiv-paper-retrieval",
      "chunk-verifier",
    ]);

    // An empty group still shows, says so and can be run.
    const b = group("project_B");
    expect(
      within(b).getByRole("button", { name: /project_B/ }).textContent
    ).toContain("0");
    expect(within(b).getByText("No drafts waiting.")).toBeTruthy();
    expect(within(b).queryByRole("checkbox")).toBeNull();
    fireEvent.click(within(b).getByRole("button", { name: "Run now" }));
    expect(props.onRun).toHaveBeenCalledWith(B);

    // A project whose folder is missing can't run.
    const gone = within(group("gone")).getByRole("button", {
      name: "Run now",
    }) as HTMLButtonElement;
    expect(gone.disabled).toBe(true);

    // Collapsing hides the group's rows and keeps the header.
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const controlled = document.getElementById(
      toggle.getAttribute("aria-controls") ?? ""
    );
    expect(controlled?.hidden).toBe(true);
    expect(
      within(a).queryByRole("button", { name: "arxiv-paper-retrieval" })
    ).toBeNull();
  });

  it("a group checkbox selects that group's drafts and shows partial selection", () => {
    const { props, rerender } = renderList({ selected: new Set(["x"]) });

    const all = within(group("EvoSci_test")).getByRole("checkbox", {
      name: "Select all drafts in EvoSci_test",
    }) as HTMLInputElement;
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);
    fireEvent.click(all);
    expect(props.onToggle).toHaveBeenCalledWith(["x", "y"], true);

    // One row on its own.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select lit-map" }));
    expect(props.onToggle).toHaveBeenLastCalledWith(["z"], true);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Select arxiv-paper-retrieval",
        }) as HTMLInputElement
      ).checked
    ).toBe(true);

    // Every draft of the group picked: checked, not partial; a click clears it.
    rerender(
      <DraftList
        {...props}
        selected={new Set(["x", "y"])}
      />
    );
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
    fireEvent.click(all);
    expect(props.onToggle).toHaveBeenLastCalledWith(["x", "y"], false);

    // Other tabs have no checkboxes.
    rerender(
      <DraftList
        {...props}
        status="approved"
      />
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  });

  it("Run now reads Running… while its project runs", () => {
    renderList({ running: new Set([A]) });
    const a = within(group("EvoSci_test")).getByRole("button", {
      name: "Running…",
    }) as HTMLButtonElement;
    expect(a.disabled).toBe(true);
    const b = within(group("project_B")).getByRole("button", {
      name: "Run now",
    }) as HTMLButtonElement;
    expect(b.disabled).toBe(false);
  });

  it("rows show the draft, open it and mark the open one", () => {
    const { props } = renderList({ openId: "y" });
    const row = screen.getByRole("button", {
      name: "arxiv-paper-retrieval",
    });
    expect(row.textContent).toContain("arxiv-paper-retrieval");
    expect(row.textContent).toContain("Find and fetch arXiv papers by topic.");
    expect(row.textContent).toContain("new skill");
    expect(row.textContent).toContain(formatTime(new Date(x.created_at)));
    expect(row.getAttribute("aria-current")).toBeNull();
    const open = screen.getByRole("button", { name: "chunk-verifier" });
    expect(open.textContent).toContain("updates a skill");
    expect(open.getAttribute("aria-current")).toBe("true");
    fireEvent.click(row);
    expect(props.onOpen).toHaveBeenCalledWith("x");
  });

  it("approved rows say where they were installed", () => {
    renderList({
      status: "approved",
      groups: [
        {
          project: { key: A, name: "EvoSci_test", missing: false },
          label: "EvoSci_test",
          drafts: [
            { ...x, status: "approved", approved_skill_present: true },
            { ...y, status: "approved", scope: "global" },
          ],
        },
      ],
    });
    expect(
      screen.getByRole("button", { name: "arxiv-paper-retrieval" }).textContent
    ).toContain("Installed into EvoSci_test/skills");
    expect(
      screen.getByRole("button", { name: "chunk-verifier" }).textContent
    ).toContain("Installed into all projects (global)");
  });

  it("shows the empty states", () => {
    const { props, rerender } = renderList({
      groups: twoProjects({ a: [], b: [] }),
    });
    expect(
      screen.getByText("All caught up — nothing waits for review.")
    ).toBeTruthy();
    expect(screen.getAllByText("No drafts waiting.")).toHaveLength(2);
    rerender(
      <DraftList
        {...props}
        groups={[]}
        status="rejected"
      />
    );
    expect(screen.getByText("Nothing here yet.")).toBeTruthy();
    expect(
      screen.queryByText("All caught up — nothing waits for review.")
    ).toBeNull();
  });

  it("Run now and selecting wait for the project to be registered", () => {
    const unknown = draft({ proposal_id: "u", workspace_dir: "/work/unknown" });
    const { props, rerender } = renderList({
      groups: twoProjects().concat({
        project: { key: "/work/unknown", name: "unknown", missing: false },
        label: "unknown",
        drafts: [unknown],
      }),
    });

    // A project the backend no longer serves: nothing can be sent for it.
    const gone = group("unknown");
    expect(
      (
        within(gone).getByRole("button", {
          name: "Run now",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    for (const box of within(gone).getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
    expect(
      (
        within(group("project_B")).getByRole("button", {
          name: "Run now",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);

    // Before the projects are known nothing runs and nothing is picked.
    rerender(
      <DraftList
        {...props}
        registered={null}
      />
    );
    for (const run of screen.getAllByRole("button", { name: "Run now" })) {
      expect((run as HTMLButtonElement).disabled).toBe(true);
    }
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("disables every write control while the page can't write", () => {
    renderList({ canWrite: false });
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
    for (const run of screen.getAllByRole("button", { name: "Run now" })) {
      expect((run as HTMLButtonElement).disabled).toBe(true);
    }
    // Reading stays possible.
    expect(
      (
        screen.getByRole("button", {
          name: "arxiv-paper-retrieval",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });
});
