// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft, DraftScope, UnshowableFile } from "@/lib/autoskills";
import { formatFullTime, formatTime } from "@/lib/time";
import type { FilesAccess } from "@/providers/ProjectsProvider";
import { animateDialogs, dialogWords } from "@/test/animateDialogs";
import {
  mockProjects,
  readyProjects,
  TestProjectsProvider,
} from "@/test/mockProjects";
import { toast } from "sonner";
import { SWRConfig } from "swr";

// jsdom has no scrollIntoView; Radix Select calls it on the item it focuses
// when the list opens.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// The URL's query state.
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
        q.set(key, next);
        return Promise.resolve(new URLSearchParams());
      };
      return [value, set];
    },
  };
});

// Every file read, as [path, installed].
const fileReads = vi.hoisted(() => ({
  calls: [] as Array<[string | null, boolean]>,
}));
vi.mock("@/app/hooks/useAutoSkills", () => ({
  useDraftFile: (_draft: unknown, path: string | null, installed: boolean) => {
    fileReads.calls.push([path, installed]);
    return {
      text: installed ? `installed text of ${path}` : `draft text of ${path}`,
      error: null,
      loading: false,
    };
  },
}));

import { DraftDetail } from "./DraftDetail";

const A = "/work/EvoSci_test";

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

const onApprove = vi.fn((_d: Draft, _s: DraftScope) => undefined);
const onReject = vi.fn((_d: Draft) => undefined);
// The page's check of a draft's files before an approval: the files it
// can't show, at once or after reading them (null: the page dropped it).
const checkFiles = vi.fn(
  (_d: Draft): UnshowableFile[] | Promise<UnshowableFile[] | null> => []
);

function detail(
  d: Draft,
  over: {
    canWrite?: boolean;
    busy?: boolean;
    projectLabel?: string;
    /** Whether the page and the backend share this machine. */
    files?: FilesAccess;
    /** The page is checking this pane's draft's files. */
    checking?: boolean;
  } = {}
) {
  // Each mount reads with a cache of its own; a rerender keeps it.
  return (
    <TestProjectsProvider
      value={mockProjects(readyProjects(A), { files: over.files ?? "here" })}
    >
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DraftDetail
          draft={d}
          projectLabel={over.projectLabel ?? "EvoSci_test"}
          canWrite={over.canWrite ?? true}
          busy={over.busy ?? false}
          checking={over.checking ?? false}
          checkFiles={checkFiles}
          onApprove={onApprove}
          onReject={onReject}
        />
      </SWRConfig>
    </TestProjectsProvider>
  );
}

const tab = (name: string) => screen.getByRole("tab", { name });
const fullTime = (iso: string) => formatFullTime(new Date(iso));
const scopeTrigger = () => screen.getByLabelText("Install into");
function pickScope(option: string) {
  fireEvent.click(scopeTrigger());
  fireEvent.click(screen.getByRole("option", { name: option }));
}

beforeEach(() => {
  q.values.clear();
  fileReads.calls = [];
  checkFiles.mockImplementation(() => []);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DraftDetail", () => {
  it("shows SKILL.md as written and notes truncation", () => {
    const skill =
      "---\nname: arxiv-paper-retrieval\ndescription: Find papers\n---\n\n# Retrieval\n\nUse <b>arxiv</b> and *then* check.\n";
    const d = draft({
      proposal_id: "arxiv-paper-retrieval",
      description: "Find papers on arXiv.",
      skill_md: skill,
    });
    const view = render(detail(d));

    expect(
      screen.getByRole("heading", { name: "arxiv-paper-retrieval" })
    ).toBeTruthy();
    expect(screen.getByText("Find papers on arXiv.")).toBeTruthy();
    expect(screen.getByText("EvoSci_test")).toBeTruthy();
    expect(screen.getByText("new skill")).toBeTruthy();

    // The default tab, the file as written: frontmatter and markup as text.
    expect(tab("SKILL.md").getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel");
    const pre = panel.querySelector("pre");
    expect(pre?.textContent).toBe(skill);
    expect(pre?.className).toContain("whitespace-pre-wrap");
    expect(panel.querySelector("b, em, h1")).toBeNull();
    expect(
      screen.queryByText("Showing the first 200,000 characters.")
    ).toBeNull();

    view.rerender(detail({ ...d, skill_md_truncated: true }));
    expect(
      screen.getByText("Showing the first 200,000 characters.")
    ).toBeTruthy();
  });

  it("renders the rationale through the markdown pipeline", () => {
    const w = window as unknown as { __draftPwned?: boolean };
    delete w.__draftPwned;
    const d = draft({
      proposal_id: "x",
      rationale_md:
        "## Why\n\nSeen **seven** times.\n\n<script>window.__draftPwned = true</script>\n",
    });
    const view = render(detail(d));
    fireEvent.click(tab("Why this skill"));

    const panel = screen.getByRole("tabpanel");
    expect(
      within(panel).getByRole("heading", { level: 2, name: "Why" })
    ).toBeTruthy();
    expect(within(panel).getByText("seven").tagName).toBe("STRONG");
    expect(panel.querySelector("script")).toBeNull();
    expect(panel.textContent).not.toContain("__draftPwned");
    expect(w.__draftPwned).toBeUndefined();

    view.rerender(detail({ ...d, rationale_md: "  \n" }));
    expect(screen.getByText("No rationale was written.")).toBeTruthy();
  });

  it("opens a source observation in Memory › Knowledge", async () => {
    const fetchMock = vi.fn((_url: string, _init?: unknown) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            nodes: [
              { id: "O-1", summary: "Chunk outputs were checked by hand" },
              { id: "O-9", summary: "Unrelated" },
            ],
            edges: [],
          }),
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    q.values.set("memoryExec", "E-1");
    const d = draft({
      proposal_id: "x",
      source_observation_ids: ["O-1", "O-2"],
    });
    const view = render(detail(d));
    // Read only when the tab is shown.
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(tab("Where it came from"));

    const named = await screen.findByRole("button", {
      name: "Chunk outputs were checked by hand",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/memory/observations");
    // Not on this machine's memory: the id.
    expect(screen.getByRole("button", { name: "O-2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unrelated" })).toBeNull();

    fireEvent.click(named);
    expect(q.values.get("view")).toBe("memory");
    expect(q.values.get("memoryTab")).toBe("knowledge");
    expect(q.values.get("memoryObs")).toBe("O-1");
    // An execution left in the address would take Memory to History.
    expect(q.values.get("memoryExec")).toBeNull();

    // A failed read names them by id.
    view.unmount();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch")))
    );
    render(detail(d));
    fireEvent.click(tab("Where it came from"));
    expect(screen.getByRole("button", { name: "O-1" })).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "O-1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "O-2" })).toBeTruthy();
  });

  it("names the sources by id where the backend is on another machine", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const d = draft({
      proposal_id: "x",
      source_observation_ids: ["O-1", "O-2"],
    });
    const LINE =
      "These observations are on the machine that runs EvoScientist.";
    for (const files of ["elsewhere", "pending"] as const) {
      const view = render(detail(d, { files }));
      fireEvent.click(tab("Where it came from"));
      const panel = screen.getByRole("tabpanel");
      expect(within(panel).getByText(LINE)).toBeTruthy();
      expect(within(panel).getByText("O-1")).toBeTruthy();
      expect(within(panel).getByText("O-2")).toBeTruthy();
      // Neither this machine's summaries nor its Memory view.
      expect(within(panel).queryByRole("button")).toBeNull();
      // Nothing in it to focus: the panel is the tab stop.
      expect(panel.getAttribute("tabindex")).toBe("0");
      await new Promise((r) => setTimeout(r, 10));
      expect(fetchMock).not.toHaveBeenCalled();
      view.unmount();
    }

    // Once the page knows the backend is here, the summaries come.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ nodes: [{ id: "O-1", summary: "Seen here" }] }),
        })
      )
    );
    const view = render(detail(d, { files: "pending" }));
    fireEvent.click(tab("Where it came from"));
    view.rerender(detail(d, { files: "here" }));
    expect(
      await screen.findByRole("button", { name: "Seen here" })
    ).toBeTruthy();
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it("says when no source observations were recorded", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(detail(draft({ proposal_id: "x" })));
    fireEvent.click(tab("Where it came from"));
    expect(
      screen.getByText("No source observations were recorded.")
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the header names the draft's project, and all projects for a global one", () => {
    const view = render(
      detail(draft({ proposal_id: "w", scope: "workspace" }), {
        projectLabel: "project_B",
      })
    );
    expect(screen.getByText("project_B")).toBeTruthy();
    expect(screen.queryByText("all projects")).toBeNull();

    // A global draft still came from a project (the phone layout hides the
    // list's group heading): both.
    view.rerender(
      detail(draft({ proposal_id: "g", scope: "global" }), {
        projectLabel: "project_B",
      })
    );
    expect(screen.getByText("project_B")).toBeTruthy();
    expect(screen.getByText("all projects")).toBeTruthy();
  });

  it("install scope starts at the draft's own and is sent with Approve", () => {
    const a = draft({ proposal_id: "a", scope: "global" });
    const view = render(detail(a));
    expect(screen.getByText("all projects")).toBeTruthy();
    expect(scopeTrigger().textContent).toBe("All projects (global)");

    pickScope("EvoSci_test/skills (this project)");
    expect(scopeTrigger().textContent).toBe(
      "EvoSci_test/skills (this project)"
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(a, "workspace");

    // Another draft starts at its own scope, and so does this one again.
    const b = draft({ proposal_id: "b", scope: "global" });
    view.rerender(detail(b));
    expect(scopeTrigger().textContent).toBe("All projects (global)");
    view.rerender(detail(a));
    expect(scopeTrigger().textContent).toBe("All projects (global)");

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledWith(a);

    // Off while a decision runs or the page can't write.
    view.rerender(detail(a, { busy: true }));
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    view.rerender(detail(a, { canWrite: false }));
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("approving an update asks first", async () => {
    const d = draft({
      proposal_id: "paper-review-v2",
      skill_name: "paper-review-v2",
      operation: "update",
      target_skill_name: "paper-review",
    });
    render(detail(d));
    expect(screen.getByText("updates a skill")).toBeTruthy();

    const approve = screen.getByRole("button", { name: "Approve" });
    approve.focus();
    fireEvent.click(approve);
    const dialog = screen.getByRole("dialog", {
      name: "Replace an installed skill?",
    });
    expect(
      within(dialog).getByText("This replaces the installed paper-review.")
    ).toBeTruthy();
    expect(onApprove).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onApprove).not.toHaveBeenCalled();
    // The focus is back on what asked.
    expect(document.activeElement).toBe(approve);

    fireEvent.click(approve);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Replace and install",
      })
    );
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(d, "workspace");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("approving a project copy says the global skill stays", async () => {
    // Recorded for this project, the skill installed only globally: the
    // approval copies it into the project and leaves the global one.
    const d = draft({
      proposal_id: "data-cleaning",
      operation: "update",
      target_skill_name: "data-cleaning",
      install_target: "/work/EvoSci_test/skills/data-cleaning",
      install_base: "/home/u/.evoscientist/skills/data-cleaning",
    });
    render(detail(d));
    const approve = screen.getByRole("button", { name: "Approve" });
    approve.focus();
    fireEvent.click(approve);
    const dialog = screen.getByRole("dialog", {
      name: "Install a project copy?",
    });
    expect(
      within(dialog).getByText(
        "EvoSci_test gets its own data-cleaning with these changes. The global data-cleaning stays as it is."
      )
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "Replace and install" })
    ).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(approve);
    expect(onApprove).not.toHaveBeenCalled();

    fireEvent.click(approve);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Install",
      })
    );
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(d, "workspace");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("an update installed into all projects instead of its own says what it installs there", async () => {
    const copy = draft({
      proposal_id: "data-cleaning",
      operation: "update",
      target_skill_name: "data-cleaning",
      install_target: "/work/EvoSci_test/skills/data-cleaning",
      install_base: "/home/u/.evoscientist/skills/data-cleaning",
    });
    render(detail(copy));
    // What is installed at the place picked isn't known.
    pickScope("All projects (global)");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog", {
      name: "Install an updated skill?",
    });
    expect(
      within(dialog).getByText(
        "This installs the updated data-cleaning into all projects (global), in place of any copy already there."
      )
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    expect(onApprove).toHaveBeenCalledWith(copy, "global");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a global update installed into this project instead is a project copy", () => {
    // The core never replaces a copy the project has in this direction: it
    // makes the project's own copy, or refuses.
    const global = "/home/u/.evoscientist/skills/paper-review";
    const replace = draft({
      proposal_id: "paper-review-v2",
      operation: "update",
      target_skill_name: "paper-review",
      scope: "global",
      install_target: global,
      install_base: global,
    });
    render(detail(replace));
    pickScope("EvoSci_test/skills (this project)");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog", {
      name: "Install a project copy?",
    });
    expect(
      within(dialog).getByText(
        "EvoSci_test gets its own paper-review with these changes. The global paper-review stays as it is."
      )
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "Replace and install" })
    ).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    expect(onApprove).toHaveBeenCalledWith(replace, "workspace");
  });

  /** An update's question asked, with dialogs that fade out as in a
   *  browser. */
  function askAboutUpdate() {
    animateDialogs();
    const d = draft({
      proposal_id: "paper-review-v2",
      operation: "update",
      target_skill_name: "paper-review",
    });
    const view = render(detail(d));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog", {
      name: "Replace an installed skill?",
    });
    const confirm = within(dialog).getByRole("button", {
      name: "Replace and install",
    });
    return { d, view, dialog, confirm };
  }

  it("the question keeps its words while it fades out", () => {
    const { view, dialog } = askAboutUpdate();
    const asked = dialogWords(dialog);
    expect(asked).toEqual({
      title: "Replace an installed skill?",
      description: "This replaces the installed paper-review.",
      buttons: ["Cancel", "Replace and install"],
    });

    // Closed, it fades out (200 ms in a browser) while the pane goes on:
    // here it shows another draft.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    view.rerender(
      detail(
        draft({
          proposal_id: "data-cleaning",
          operation: "update",
          target_skill_name: "data-cleaning",
          install_target: "/work/EvoSci_test/skills/data-cleaning",
          install_base: "/home/u/.evoscientist/skills/data-cleaning",
        })
      )
    );
    expect(dialog.isConnected).toBe(true);
    expect(dialog.getAttribute("data-state")).toBe("closed");
    expect(dialogWords(dialog)).toEqual(asked);
  });

  it("a click on the question while it fades out after Cancel doesn't approve", () => {
    const { dialog, confirm } = askAboutUpdate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(dialog.isConnected).toBe(true);
    expect(dialog.getAttribute("data-state")).toBe("closed");
    fireEvent.click(confirm);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("a second click on the question while it fades out doesn't approve again", () => {
    const { d, dialog, confirm } = askAboutUpdate();
    fireEvent.click(confirm);
    expect(dialog.isConnected).toBe(true);
    expect(dialog.getAttribute("data-state")).toBe("closed");
    fireEvent.click(confirm);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(d, "workspace");
  });

  const BIG: UnshowableFile = {
    path: "data/big.csv",
    size: 1_100_000,
    reason: "too_large",
  };
  /** The question's file list, line by line. */
  const fileLines = (dialog: HTMLElement) =>
    within(dialog)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
  /** What the dialog's description says, all of it. */
  const describedBy = (dialog: HTMLElement) =>
    document.getElementById(dialog.getAttribute("aria-describedby") ?? "")
      ?.textContent;

  it("approving a new skill with a file the page can't show asks first", async () => {
    checkFiles.mockImplementation(() => [BIG]);
    const d = draft({
      proposal_id: "csv-profiler",
      skill_name: "csv-profiler",
      files: [
        { path: "SKILL.md", size: 120, installed: false },
        { path: "data/big.csv", size: 1_100_000, installed: false },
      ],
    });
    render(detail(d));
    const approve = screen.getByRole("button", { name: "Approve" });
    approve.focus();
    fireEvent.click(approve);
    expect(checkFiles).toHaveBeenCalledWith(d);
    const dialog = screen.getByRole("dialog", {
      name: "Install files you haven't seen?",
    });
    expect(dialogWords(dialog).buttons).toEqual(["Cancel", "Install anyway"]);
    expect(
      within(dialog).getByText("csv-profiler holds files this page can't show:")
    ).toBeTruthy();
    expect(fileLines(dialog)).toEqual([
      "data/big.csv (1.05 MB) — too large to show",
    ]);
    expect(
      within(dialog).getByText("They are installed with the skill.")
    ).toBeTruthy();
    // All of it is the dialog's description.
    expect(describedBy(dialog)).toBe(
      "csv-profiler holds files this page can't show:data/big.csv (1.05 MB) — too large to showThey are installed with the skill."
    );
    expect(onApprove).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onApprove).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(approve);

    fireEvent.click(approve);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Install anyway",
      })
    );
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(d, "workspace");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("names a file that isn't text and one it couldn't check", () => {
    checkFiles.mockImplementation(() => [
      { path: "logo.png", size: 2048, reason: "not_text" },
      { path: "notes.md", size: 30, reason: "unchecked" },
    ]);
    render(detail(draft({ proposal_id: "thesis-figure-kit" })));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog", {
      name: "Install files you haven't seen?",
    });
    expect(fileLines(dialog)).toEqual([
      "logo.png — not text",
      "notes.md — couldn't be checked",
    ]);
  });

  it("a new skill whose files can all be shown is approved without a question", () => {
    const d = draft({ proposal_id: "x" });
    render(detail(d));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(checkFiles).toHaveBeenCalledWith(d);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onApprove).toHaveBeenCalledWith(d, "workspace");
  });

  it("an update with a file the page can't show adds the files to its question", () => {
    checkFiles.mockImplementation(() => [BIG]);
    const d = draft({
      proposal_id: "paper-review-v2",
      operation: "update",
      target_skill_name: "paper-review",
    });
    render(detail(d));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog", {
      name: "Replace an installed skill?",
    });
    expect(describedBy(dialog)).toBe(
      "This replaces the installed paper-review.paper-review-v2 holds files this page can't show:data/big.csv (1.05 MB) — too large to showThey are installed with the skill."
    );
    expect(dialogWords(dialog).buttons).toEqual([
      "Cancel",
      "Replace and install",
    ]);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Replace and install" })
    );
    expect(onApprove).toHaveBeenCalledWith(d, "workspace");
  });

  it("an update whose files can all be shown asks only its own question", () => {
    const d = draft({
      proposal_id: "paper-review-v2",
      operation: "update",
      target_skill_name: "paper-review",
    });
    render(detail(d));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog", {
      name: "Replace an installed skill?",
    });
    expect(within(dialog).queryByRole("list")).toBeNull();
    expect(describedBy(dialog)).toBe(
      "This replaces the installed paper-review."
    );
  });

  it("waits for a check that reads files, reading Checking files… meanwhile", async () => {
    let answer: (files: UnshowableFile[] | null) => void = () => {};
    checkFiles.mockImplementation(
      () => new Promise<UnshowableFile[] | null>((r) => (answer = r))
    );
    const d = draft({ proposal_id: "csv-profiler" });
    const view = render(detail(d));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onApprove).not.toHaveBeenCalled();

    // The page is busy with the check: this Approve says so.
    view.rerender(detail(d, { busy: true, checking: true }));
    const checking = screen.getByRole("button", {
      name: "Checking files…",
    }) as HTMLButtonElement;
    expect(checking.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    // Only the pane that checks says so; another pane is just busy.
    view.rerender(detail(d, { busy: true }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();

    view.rerender(detail(d, { busy: true, checking: true }));
    await act(async () => answer([BIG]));
    view.rerender(detail(d));
    expect(
      screen.getByRole("dialog", { name: "Install files you haven't seen?" })
    ).toBeTruthy();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("a check that finds nothing approves once it answers", async () => {
    let answer: (files: UnshowableFile[] | null) => void = () => {};
    checkFiles.mockImplementation(
      () => new Promise<UnshowableFile[] | null>((r) => (answer = r))
    );
    const d = draft({ proposal_id: "x", scope: "global" });
    render(detail(d));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).not.toHaveBeenCalled();
    await act(async () => answer([]));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(d, "global");
  });

  it("the decision is the one shown at the click, though the place changes while the files are read", async () => {
    const answers: Array<(files: UnshowableFile[] | null) => void> = [];
    checkFiles.mockImplementation(
      () => new Promise<UnshowableFile[] | null>((r) => answers.push(r))
    );
    // No question: the place shown at the click goes.
    const c = draft({ proposal_id: "c", scope: "workspace" });
    const view = render(detail(c));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    pickScope("All projects (global)");
    await act(async () => answers[0]([]));
    expect(onApprove.mock.calls).toEqual([[c, "workspace"]]);

    // The question asks about, and its button sends, the place shown at the
    // click.
    const u = draft({
      proposal_id: "u",
      operation: "update",
      target_skill_name: "paper-review",
      scope: "workspace",
    });
    view.rerender(detail(u));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    pickScope("All projects (global)");
    await act(async () => answers[1]([BIG]));
    const dialog = screen.getByRole("dialog", {
      name: "Replace an installed skill?",
    });
    expect(describedBy(dialog)).toContain(
      "This replaces the installed paper-review."
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Replace and install" })
    );
    expect(onApprove.mock.calls[1]).toEqual([u, "workspace"]);
  });

  it("Install into is off while the draft's files are checked", () => {
    const d = draft({ proposal_id: "x" });
    const view = render(detail(d, { busy: true, checking: true }));
    expect((scopeTrigger() as HTMLButtonElement).disabled).toBe(true);
    view.rerender(detail(d));
    expect((scopeTrigger() as HTMLButtonElement).disabled).toBe(false);
  });

  it("a check of a version the pane no longer shows asks nothing and approves nothing; it says so only for a change", async () => {
    const errors = vi.spyOn(toast, "error");
    try {
      const CHANGED =
        "Nothing was installed: the drafts changed while their files were checked. Approve again.";
      const answers: Array<(files: UnshowableFile[] | null) => void> = [];
      checkFiles.mockImplementation(
        () => new Promise<UnshowableFile[] | null>((r) => answers.push(r))
      );
      const d = draft({ proposal_id: "x" });
      const view = render(detail(d));

      // Rewritten in place while its files were read.
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      view.rerender(detail({ ...d, updated_at: "2026-11-02T09:00:00Z" }));
      await act(async () => answers[0]([BIG]));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(errors.mock.calls).toEqual([[CHANGED]]);

      // Another draft opened meanwhile: the user's own move, said nothing.
      view.rerender(detail(d));
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      view.rerender(detail(draft({ proposal_id: "y" })));
      await act(async () => answers[1]([]));
      expect(onApprove).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledTimes(1);

      // Decided elsewhere meanwhile, or the page can't decide it any more.
      view.rerender(detail(d));
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      view.rerender(detail({ ...d, status: "approved" }));
      await act(async () => answers[2]([]));
      view.rerender(detail(d));
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      view.rerender(detail(d, { canWrite: false }));
      await act(async () => answers[3]([]));
      expect(onApprove).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledTimes(3);

      // A check the page dropped answers null: the page said why, if at all.
      view.rerender(detail(d));
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await act(async () => answers[4](null));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onApprove).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledTimes(3);

      // The pane closed meanwhile: said nothing either.
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      view.unmount();
      await act(async () => answers[5]([]));
      expect(onApprove).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledTimes(3);
      expect(new Set(errors.mock.calls.map((c) => c[0]))).toEqual(
        new Set([CHANGED])
      );
    } finally {
      errors.mockRestore();
    }
  });

  it("the files question keeps its words while it fades out", () => {
    animateDialogs();
    checkFiles.mockImplementation(() => [BIG]);
    const view = render(detail(draft({ proposal_id: "csv-profiler" })));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog", {
      name: "Install files you haven't seen?",
    });
    const asked = dialogWords(dialog);
    expect(asked.buttons).toEqual(["Cancel", "Install anyway"]);
    expect(asked.description).toContain(
      "data/big.csv (1.05 MB) — too large to show"
    );

    const confirm = within(dialog).getByRole("button", {
      name: "Install anyway",
    });
    fireEvent.click(confirm);
    // Fading out while the pane shows another draft.
    checkFiles.mockImplementation(() => []);
    view.rerender(
      detail(
        draft({
          proposal_id: "paper-review-v2",
          operation: "update",
          target_skill_name: "paper-review",
        })
      )
    );
    expect(dialog.isConnected).toBe(true);
    expect(dialog.getAttribute("data-state")).toBe("closed");
    expect(dialogWords(dialog)).toEqual(asked);
    // And it approves nothing more.
    fireEvent.click(confirm);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("shows the install error for the recorded scope only", () => {
    const error =
      "A skill named arxiv-paper-retrieval is already installed in EvoSci_test/skills.";
    render(
      detail(
        draft({
          proposal_id: "arxiv-paper-retrieval",
          scope: "workspace",
          install_error: error,
        })
      )
    );
    expect(screen.getByText(error)).toBeTruthy();
    // Read out with the list it describes.
    const described = scopeTrigger().getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toBe(error);

    pickScope("All projects (global)");
    expect(screen.queryByText(error)).toBeNull();
    expect(scopeTrigger().getAttribute("aria-describedby")).toBeNull();

    pickScope("EvoSci_test/skills (this project)");
    expect(screen.getByText(error)).toBeTruthy();
  });

  it("decided drafts show where they went or that they were rejected", () => {
    const at = "2026-11-03T10:00:00Z";
    const approved = draft({
      proposal_id: "arxiv-paper-retrieval",
      status: "approved",
      approved_at: at,
      approved_by: "auto",
      approved_skill_path: "/work/EvoSci_test/skills/arxiv-paper-retrieval",
      approved_skill_present: true,
    });
    const view = render(detail(approved));
    expect(screen.getByText("Installed into EvoSci_test/skills")).toBeTruthy();
    expect(screen.getByText("installed automatically")).toBeTruthy();
    // "Approved · Yesterday", the full date and time on the <time>.
    const when = screen.getByText(formatTime(new Date(at)));
    expect(when.tagName).toBe("TIME");
    expect(when.getAttribute("datetime")).toBe(at);
    expect(when.getAttribute("title")).toBe(fullTime(at));
    expect(when.parentElement?.textContent).toBe(
      `Approved · ${formatTime(new Date(at))}`
    );
    expect(screen.queryByLabelText("Install into")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();

    view.rerender(
      detail({ ...approved, scope: "global", approved_by: "user" })
    );
    expect(
      screen.getByText("Installed into all projects (global)")
    ).toBeTruthy();
    expect(screen.queryByText("installed automatically")).toBeNull();

    const rejected = draft({
      proposal_id: "y",
      status: "rejected",
      rejected_at: "2026-10-20T08:00:00Z",
    });
    view.rerender(detail(rejected));
    expect(
      screen.getByText("Rejected. EvoMemory won't draft this pattern again.")
    ).toBeTruthy();
    const rejectedAt = "2026-10-20T08:00:00Z";
    const whenRejected = screen.getByText(formatTime(new Date(rejectedAt)));
    expect(whenRejected.getAttribute("title")).toBe(fullTime(rejectedAt));
    expect(whenRejected.parentElement?.textContent).toBe(
      `Rejected · ${formatTime(new Date(rejectedAt))}`
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("the tabs move with arrows, Home and End and show the files", () => {
    const d = draft({
      proposal_id: "x",
      files: [{ path: "SKILL.md", size: 10, installed: false }],
    });
    render(detail(d));
    const first = tab("SKILL.md");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("Files"));
    expect(tab("Files").getAttribute("aria-selected")).toBe("true");
    expect(tab("Files").tabIndex).toBe(0);
    expect(tab("SKILL.md").tabIndex).toBe(-1);
    expect(screen.getByText("draft text of SKILL.md")).toBeTruthy();

    fireEvent.keyDown(tab("Files"), { key: "Home" });
    expect(document.activeElement).toBe(tab("SKILL.md"));
    fireEvent.keyDown(tab("SKILL.md"), { key: "End" });
    expect(document.activeElement).toBe(tab("Files"));
    fireEvent.keyDown(tab("Files"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("SKILL.md"));
    fireEvent.keyDown(tab("SKILL.md"), { key: "ArrowRight" });
    expect(tab("Why this skill").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      tab("Why this skill").id
    );
  });
  it("files compare with the installed copy only for the recorded place", () => {
    const note =
      "Changes against the installed copy are shown for the recorded place only.";
    const d = draft({
      proposal_id: "paper-review",
      operation: "update",
      target_skill_name: "paper-review",
      scope: "workspace",
      install_base: "/home/u/.evoscientist/skills/paper-review",
      files: [{ path: "SKILL.md", size: 10, installed: true }],
    });
    render(detail(d));
    fireEvent.click(tab("Files"));
    expect(screen.getByRole("list", { name: "Changes" })).toBeTruthy();
    expect(screen.queryByText(note)).toBeNull();

    fileReads.calls = [];
    pickScope("All projects (global)");
    expect(screen.getByText(note)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Changes" })).toBeNull();
    expect(screen.getByText("draft text of SKILL.md")).toBeTruthy();
    expect(fileReads.calls.filter(([, installed]) => installed)).toEqual([]);

    pickScope("EvoSci_test/skills (this project)");
    expect(screen.queryByText(note)).toBeNull();
    expect(screen.getByRole("list", { name: "Changes" })).toBeTruthy();
  });

  it("an open question doesn't follow to another draft", () => {
    const a = draft({
      proposal_id: "a",
      operation: "update",
      target_skill_name: "a",
    });
    const b = draft({ proposal_id: "b" });
    const view = render(detail(a));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    view.rerender(detail(b));
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(detail(a));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a draft rewritten in place starts at its new recorded scope, without the question", () => {
    const a = draft({
      proposal_id: "a",
      scope: "workspace",
      operation: "update",
      target_skill_name: "a",
    });
    const view = render(detail(a));
    pickScope("All projects (global)");
    // The same draft read again keeps the pick.
    view.rerender(detail({ ...a }));
    expect(scopeTrigger().textContent).toBe("All projects (global)");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    // A run rewrote it (same id, new updated_at): the question and the old
    // pick go, and it starts where it records now.
    const rewritten = { ...a, updated_at: "2026-11-02T09:00:00Z" };
    view.rerender(detail(rewritten));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(scopeTrigger().textContent).toBe(
      "EvoSci_test/skills (this project)"
    );
    // The scope it shows is the one sent.
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Replace and install",
      })
    );
    expect(onApprove).toHaveBeenCalledWith(rewritten, "workspace");

    // Resubmitted with another scope: that one shows.
    const moved = {
      ...rewritten,
      scope: "global" as const,
      updated_at: "2026-11-03T09:00:00Z",
    };
    view.rerender(detail(moved));
    expect(scopeTrigger().textContent).toBe("All projects (global)");
  });

  it("the question's Replace and install waits while it can't decide", () => {
    const d = draft({
      proposal_id: "u",
      operation: "update",
      target_skill_name: "u",
    });
    const view = render(detail(d));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const replace = () =>
      screen.getByRole("button", {
        name: "Replace and install",
      }) as HTMLButtonElement;

    view.rerender(detail(d, { busy: true }));
    expect(replace().disabled).toBe(true);
    fireEvent.click(replace());
    view.rerender(detail(d, { canWrite: false }));
    expect(replace().disabled).toBe(true);
    fireEvent.click(replace());
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("after a confirmed update the focus goes to the heading once Approve is off", async () => {
    const d = draft({
      proposal_id: "u",
      skill_name: "paper-review-v2",
      operation: "update",
      target_skill_name: "paper-review",
    });
    const view = render(detail(d));
    const approve = screen.getByRole("button", { name: "Approve" });
    approve.focus();
    fireEvent.click(approve);
    fireEvent.click(
      screen.getByRole("button", { name: "Replace and install" })
    );
    expect(onApprove).toHaveBeenCalledWith(d, "workspace");
    // The decision runs: Approve turns off before the dialog hands the
    // focus back (on the next tick).
    view.rerender(detail(d, { busy: true }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "paper-review-v2" })
      )
    );
  });

  it("only the panels with nothing to focus are a tab stop", () => {
    const d = draft({
      proposal_id: "x",
      rationale_md: "Because.",
      source_observation_ids: ["O-1"],
      files: [{ path: "SKILL.md", size: 10, installed: false }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch")))
    );
    const view = render(detail(d));
    const panel = () => screen.getByRole("tabpanel");
    expect(panel().getAttribute("tabindex")).toBe("0");
    fireEvent.click(tab("Why this skill"));
    expect(panel().getAttribute("tabindex")).toBe("0");
    fireEvent.click(tab("Where it came from"));
    expect(panel().getAttribute("tabindex")).toBeNull();
    fireEvent.click(tab("Files"));
    expect(panel().getAttribute("tabindex")).toBeNull();

    // Their empty states hold nothing to focus either.
    const empty = { ...d, source_observation_ids: [], files: [] };
    view.rerender(detail(empty));
    expect(panel().getAttribute("tabindex")).toBe("0");
    fireEvent.click(tab("Where it came from"));
    expect(panel().getAttribute("tabindex")).toBe("0");
  });

  it("reads the observations once for every draft shown", async () => {
    const fetchMock = vi.fn((_url: string, _init?: unknown) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            nodes: [
              { id: "O-1", summary: "First pattern" },
              { id: "O-2", summary: "Second pattern" },
            ],
            edges: [],
          }),
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const a = draft({ proposal_id: "a", source_observation_ids: ["O-1"] });
    const b = draft({ proposal_id: "b", source_observation_ids: ["O-2"] });
    const view = render(detail(a));
    fireEvent.click(tab("Where it came from"));
    expect(
      await screen.findByRole("button", { name: "First pattern" })
    ).toBeTruthy();

    view.rerender(detail(b));
    expect(screen.getByRole("button", { name: "Second pattern" })).toBeTruthy();
    // Away and back again.
    fireEvent.click(tab("SKILL.md"));
    fireEvent.click(tab("Where it came from"));
    expect(screen.getByRole("button", { name: "Second pattern" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
