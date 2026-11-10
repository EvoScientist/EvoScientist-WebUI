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

// What a file read gives the pane.
interface FileRead {
  text: string | null;
  error: string | null;
  loading: boolean;
  status: number | null;
}
// Every file read, as [path, installed]. A read answers its text at once,
// unless the test brings its own answer for a path (`answer`), or reads
// through the real hook and a stubbed fetch (`real`).
const fileReads = vi.hoisted(() => ({
  calls: [] as Array<[string | null, boolean]>,
  answer: undefined as
    | ((path: string | null) => Partial<FileRead> | undefined)
    | undefined,
  real: false,
}));
vi.mock("@/app/hooks/useAutoSkills", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/app/hooks/useAutoSkills")
  >();
  return {
    useDraftFile: (
      draft: Draft | null,
      path: string | null,
      installed: boolean
    ): FileRead => {
      fileReads.calls.push([path, installed]);
      // The same for a whole test, so the hooks called never change.
      if (fileReads.real) return actual.useDraftFile(draft, path, installed);
      return {
        text: installed ? `installed text of ${path}` : `draft text of ${path}`,
        error: null,
        loading: false,
        status: null,
        ...fileReads.answer?.(path),
      };
    },
  };
});
vi.mock("@/providers/ClientProvider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDeployment: () => ({ deploymentUrl: "http://127.0.0.1:6174", apiKey: "" }),
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
    /** Hears of each read of the real reader that failed. */
    onReadError?: () => void;
  } = {}
) {
  // Each mount reads with a cache of its own; a rerender keeps it.
  return (
    <TestProjectsProvider
      value={mockProjects(readyProjects(A), { files: over.files ?? "here" })}
    >
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          // (An undefined one would replace SWR's own.)
          ...(over.onReadError ? { onError: over.onReadError } : {}),
        }}
      >
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
  fileReads.answer = undefined;
  fileReads.real = false;
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

  it("an update installed into all projects instead of its own says the global skill is updated", async () => {
    const copy = draft({
      proposal_id: "data-cleaning",
      operation: "update",
      target_skill_name: "data-cleaning",
      install_target: "/work/EvoSci_test/skills/data-cleaning",
      install_base: "/home/u/.evoscientist/skills/data-cleaning",
    });
    render(detail(copy));
    // The core updates the global skill in place and writes no project's
    // own copy, which that project goes on using.
    pickScope("All projects (global)");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog", {
      name: "Install an updated skill?",
    });
    expect(
      within(dialog).getByText(
        "This updates the global data-cleaning. Projects with their own data-cleaning keep theirs."
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

  describe("an update of the project's own copy", () => {
    const OWN = "/work/EvoSci_test/skills/paper-review";
    const GLOBAL = "/home/u/.evoscientist/skills/paper-review";
    // Recorded for the project, which has its own paper-review: with
    // "global" the core would update only the global copy (or refuse without
    // one), and the project would go on using its own.
    const own = draft({
      proposal_id: "paper-review-v2",
      operation: "update",
      target_skill_name: "paper-review",
      install_target: OWN,
      install_base: OWN,
    });
    const picker = () => screen.queryByRole("combobox");
    const NOTE =
      "This project has its own paper-review, so the update goes there.";

    it("goes into the project, with no other place offered", async () => {
      render(detail(own));
      expect(picker()).toBeNull();
      const place = screen.getByRole("group", { name: "Install into" });
      expect(
        within(place).getByText("EvoSci_test/skills (this project)")
      ).toBeTruthy();
      expect(within(place).getByText(NOTE)).toBeTruthy();
      expect(screen.queryByText("All projects (global)")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      const dialog = screen.getByRole("dialog", {
        name: "Replace an installed skill?",
      });
      expect(
        within(dialog).getByText("This replaces the installed paper-review.")
      ).toBeTruthy();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Replace and install" })
      );
      expect(onApprove).toHaveBeenCalledTimes(1);
      expect(onApprove).toHaveBeenCalledWith(own, "workspace");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("names the skill it updates, not the draft, and the project by its label", () => {
      render(detail(own, { projectLabel: "EvoSci_test (work)" }));
      expect(
        screen.getByText("EvoSci_test (work)/skills (this project)")
      ).toBeTruthy();
      expect(screen.getByText(NOTE)).toBeTruthy();
      expect(screen.queryByText(/paper-review-v2, so the update/)).toBeNull();
    });

    it("every other draft still picks its place", () => {
      const others: Array<[string, Draft]> = [
        [
          "an update of a global skill",
          draft({
            proposal_id: "g",
            operation: "update",
            target_skill_name: "paper-review",
            scope: "global",
            install_target: GLOBAL,
            install_base: GLOBAL,
          }),
        ],
        [
          "a project copy of a global skill",
          draft({
            proposal_id: "c",
            operation: "update",
            target_skill_name: "paper-review",
            install_target: OWN,
            install_base: GLOBAL,
          }),
        ],
        ["a new skill", draft({ proposal_id: "n" })],
        [
          // The same folder for both, but nothing is updated in it.
          "a new skill with a target",
          draft({ proposal_id: "n2", install_target: OWN, install_base: OWN }),
        ],
        [
          // The project's copy is gone: nothing says it has its own.
          "an update whose place the core can't find",
          draft({
            proposal_id: "e",
            operation: "update",
            target_skill_name: "paper-review",
            install_error: "No installed workspace skill named 'paper-review'",
          }),
        ],
      ];
      for (const [name, d] of others) {
        const view = render(detail(d));
        expect(picker(), name).not.toBeNull();
        expect(screen.queryByText(/so the update goes there/), name).toBeNull();
        fireEvent.click(scopeTrigger());
        expect(
          screen.getAllByRole("option").map((o) => o.textContent),
          name
        ).toEqual([
          "EvoSci_test/skills (this project)",
          "All projects (global)",
        ]);
        view.unmount();
      }
    });

    it("a place picked before the project had its own copy isn't sent", () => {
      const files = [{ path: "SKILL.md", size: 10, installed: true }];
      const mine = { ...own, files };
      // Listed first as a project copy of a global skill, and global picked.
      const view = render(detail({ ...mine, install_base: GLOBAL }));
      pickScope("All projects (global)");
      expect(scopeTrigger().textContent).toBe("All projects (global)");
      // The same version, listed again: the project has its own copy now.
      view.rerender(detail(mine));
      expect(picker()).toBeNull();
      // Its files compare with that copy, the place it goes to.
      fireEvent.click(tab("Files"));
      expect(screen.getByRole("list", { name: "Changes" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      fireEvent.click(
        within(
          screen.getByRole("dialog", { name: "Replace an installed skill?" })
        ).getByRole("button", { name: "Replace and install" })
      );
      expect(onApprove).toHaveBeenCalledTimes(1);
      expect(onApprove).toHaveBeenCalledWith(mine, "workspace");
    });
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

  it("leaving the draft while its files are checked gives the click up for good, though the draft comes back", async () => {
    const errors = vi.spyOn(toast, "error");
    try {
      const answers: Array<(files: UnshowableFile[] | null) => void> = [];
      checkFiles.mockImplementation(
        () => new Promise<UnshowableFile[] | null>((r) => answers.push(r))
      );
      const x = draft({ proposal_id: "x", scope: "workspace" });
      const u = draft({
        proposal_id: "u",
        operation: "update",
        target_skill_name: "paper-review",
      });
      const y = draft({ proposal_id: "y" });
      const view = render(detail(x));

      // Clicked for all projects, then y shown and x again: x is back at its
      // own place, and the click into all projects is gone.
      pickScope("All projects (global)");
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      view.rerender(detail(y));
      view.rerender(detail(x));
      expect(scopeTrigger().textContent).toBe(
        "EvoSci_test/skills (this project)"
      );
      await act(async () => answers[0]([]));
      expect(onApprove).not.toHaveBeenCalled();

      // An update: its question doesn't come either.
      view.rerender(detail(u));
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      view.rerender(detail(y));
      view.rerender(detail(u));
      await act(async () => answers[1]([BIG]));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onApprove).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();

      // A click after coming back goes as usual.
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await act(async () => answers[2]([]));
      expect(
        screen.getByRole("dialog", { name: "Replace an installed skill?" })
      ).toBeTruthy();
    } finally {
      errors.mockRestore();
    }
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
      screen.getByText(
        "Rejected. EvoMemory won't suggest it again unless the observations behind it change."
      )
    ).toBeTruthy();
    const rejectedAt = "2026-10-20T08:00:00Z";
    const whenRejected = screen.getByText(formatTime(new Date(rejectedAt)));
    expect(whenRejected.getAttribute("title")).toBe(fullTime(rejectedAt));
    expect(whenRejected.parentElement?.textContent).toBe(
      `Rejected · ${formatTime(new Date(rejectedAt))}`
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  // The list carries the texts of pending drafts only (it is polled, and
  // decided drafts only grow in number): a decided draft's are null there.
  describe("a decided draft, whose texts the list doesn't carry", () => {
    const decided = (over: Partial<Draft> = {}) =>
      draft({
        proposal_id: "arxiv-paper-retrieval",
        status: "approved",
        approved_at: "2026-11-03T10:00:00Z",
        approved_by: "user",
        skill_md: null,
        rationale_md: null,
        ...over,
      });
    const answers = (byPath: Record<string, Partial<FileRead>>) => {
      fileReads.answer = (path) => byPath[path ?? ""];
    };
    const panel = () => screen.getByRole("tabpanel");
    const CUT = "Showing the first 200,000 characters.";

    it("reads SKILL.md and the rationale through the file route, each when its tab shows", () => {
      const skill = "---\nname: x\n---\n\n# Retrieval <b>now</b>\n";
      answers({
        "SKILL.md": { text: skill },
        "RATIONALE.md": { text: "## Why\n\nSeen **seven** times.\n" },
      });
      render(detail(decided()));

      // SKILL.md as written; the rationale isn't read before its tab shows.
      const pre = panel().querySelector("pre");
      expect(pre?.textContent).toBe(skill);
      expect(panel().querySelector("b, h1")).toBeNull();
      expect(fileReads.calls).toContainEqual(["SKILL.md", false]);
      expect(fileReads.calls.some(([path]) => path === "RATIONALE.md")).toBe(
        false
      );
      // The whole file: nothing was cut.
      expect(screen.queryByText(CUT)).toBeNull();

      fireEvent.click(tab("Why this skill"));
      expect(
        within(panel()).getByRole("heading", { level: 2, name: "Why" })
      ).toBeTruthy();
      expect(within(panel()).getByText("seven").tagName).toBe("STRONG");
      expect(screen.queryByText(CUT)).toBeNull();
      // The draft's own copies, never the installed skill's.
      expect(new Set(fileReads.calls.map((c) => c.join("|")))).toEqual(
        new Set(["SKILL.md|false", "RATIONALE.md|false"])
      );
    });

    it("says so while a text is read", () => {
      answers({
        "SKILL.md": { text: null, loading: true },
        "RATIONALE.md": { text: null, loading: true },
      });
      render(detail(decided({ status: "rejected" })));
      expect(within(panel()).getByText("Loading…")).toBeTruthy();
      expect(panel().querySelector("pre")).toBeNull();
      fireEvent.click(tab("Why this skill"));
      expect(within(panel()).getByText("Loading…")).toBeTruthy();
      expect(screen.queryByText("No rationale was written.")).toBeNull();
    });

    it("says what the file route answered when a text can't be shown", () => {
      const cases: Array<[number | null, string]> = [
        [413, "This file is too large to show here."],
        [415, "This file isn't text, so it isn't shown."],
        [500, "Couldn't read this file."],
        [null, "Couldn't read this file."],
      ];
      for (const [status, message] of cases) {
        answers({
          "SKILL.md": { text: null, error: message, status },
          "RATIONALE.md": { text: null, error: message, status },
        });
        const view = render(detail(decided()));
        expect(within(panel()).getByText(message)).toBeTruthy();
        expect(panel().querySelector("pre")).toBeNull();
        fireEvent.click(tab("Why this skill"));
        expect(within(panel()).getByText(message)).toBeTruthy();
        expect(screen.queryByText("No rationale was written.")).toBeNull();
        view.unmount();
      }

      // A SKILL.md that is gone says so.
      const gone = "This file is gone or can't be read.";
      answers({ "SKILL.md": { text: null, error: gone, status: 404 } });
      render(detail(decided()));
      expect(within(panel()).getByText(gone)).toBeTruthy();
    });

    it("a draft without a RATIONALE.md says no rationale was written", () => {
      answers({
        "RATIONALE.md": {
          text: null,
          error: "This file is gone or can't be read.",
          status: 404,
        },
      });
      const view = render(detail(decided()));
      fireEvent.click(tab("Why this skill"));
      expect(panel().textContent).toBe("No rationale was written.");

      // A blank one says the same.
      answers({ "RATIONALE.md": { text: "  \n" } });
      view.rerender(detail(decided()));
      expect(panel().textContent).toBe("No rationale was written.");
    });

    // The reader reads a file again when the window is focused or its tab
    // shows again, and keeps the last text beside the error of a read that
    // failed: the text read stays on screen.
    it("a re-read that fails leaves the text that was read on screen", () => {
      const skill = "# Retrieval\n";
      const why = "Seen **seven** times.\n";
      const failed = "Couldn't read this file.";
      answers({
        "SKILL.md": { text: skill, error: failed, status: 500 },
        "RATIONALE.md": { text: why, error: failed, status: null },
      });
      const view = render(detail(decided()));
      expect(panel().querySelector("pre")?.textContent).toBe(skill);
      expect(screen.queryByText(failed)).toBeNull();
      fireEvent.click(tab("Why this skill"));
      expect(within(panel()).getByText("seven").tagName).toBe("STRONG");
      expect(screen.queryByText(failed)).toBeNull();

      // Also a re-read that says the file is gone: a rationale that was
      // read is not "No rationale was written.".
      const gone = "This file is gone or can't be read.";
      answers({
        "SKILL.md": { text: skill, error: gone, status: 404 },
        "RATIONALE.md": { text: why, error: gone, status: 404 },
      });
      view.rerender(detail(decided()));
      expect(within(panel()).getByText("seven").tagName).toBe("STRONG");
      expect(screen.queryByText("No rationale was written.")).toBeNull();
      expect(screen.queryByText(gone)).toBeNull();
      fireEvent.click(tab("SKILL.md"));
      expect(panel().querySelector("pre")?.textContent).toBe(skill);
      expect(screen.queryByText(gone)).toBeNull();
    });

    it("the real reader: texts read stay through re-reads that fail, on focus and when their tab shows again", async () => {
      fileReads.real = true;
      let down = false;
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, _init?: RequestInit) => {
          if (down) return new Response("{}", { status: 500 });
          return new URL(String(input)).searchParams.get("path") ===
            "RATIONALE.md"
            ? new Response("Seen **seven** times.\n")
            : new Response("# as installed\n");
        }
      );
      vi.stubGlobal("fetch", fetchMock);
      const onReadError = vi.fn();
      const failedReads = async (n: number) => {
        await waitFor(() => expect(onReadError).toHaveBeenCalledTimes(n));
        // The failed answer is rendered.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
      const skillShown = () =>
        expect(panel().querySelector("pre")?.textContent).toBe(
          "# as installed\n"
        );
      const FAILED = "Couldn't read this file.";
      render(detail(decided(), { onReadError }));
      await waitFor(skillShown);
      fireEvent.click(tab("Why this skill"));
      await waitFor(() =>
        expect(within(panel()).getByText("seven").tagName).toBe("STRONG")
      );

      // The backend goes away. SKILL.md's tab shows again: its re-read
      // fails, and the text read before stays.
      down = true;
      fireEvent.click(tab("SKILL.md"));
      await failedReads(1);
      skillShown();
      expect(screen.queryByText(FAILED)).toBeNull();

      // The window is focused (SWR reads on focus at most every 5 s).
      const later = Date.now() + 6_000;
      const now = vi.spyOn(Date, "now").mockReturnValue(later);
      try {
        act(() => {
          window.dispatchEvent(new Event("focus"));
        });
        await failedReads(2);
      } finally {
        now.mockRestore();
      }
      skillShown();
      expect(screen.queryByText(FAILED)).toBeNull();

      // The rationale's tab shows again: the same.
      fireEvent.click(tab("Why this skill"));
      await failedReads(3);
      expect(within(panel()).getByText("seven").tagName).toBe("STRONG");
      expect(screen.queryByText(FAILED)).toBeNull();
      expect(screen.queryByText("No rationale was written.")).toBeNull();
    });

    it("an older core's texts in the list are shown as before, and nothing is read", () => {
      const view = render(
        detail(
          decided({
            skill_md: "# from the list",
            skill_md_truncated: true,
            rationale_md: "Because **twice**.",
            rationale_md_truncated: true,
          })
        )
      );
      expect(panel().querySelector("pre")?.textContent).toBe("# from the list");
      expect(screen.getByText(CUT)).toBeTruthy();
      fireEvent.click(tab("Why this skill"));
      expect(within(panel()).getByText("twice").tagName).toBe("STRONG");
      expect(screen.getByText(CUT)).toBeTruthy();

      // Each text on its own: the one the list has is shown from the list.
      view.rerender(detail(decided({ rationale_md: "" })));
      expect(panel().textContent).toBe("No rationale was written.");
      expect(fileReads.calls).toEqual([]);
    });

    it("a pending draft's texts come from the list, and nothing is read", () => {
      render(
        detail(
          draft({ proposal_id: "x", skill_md: "# s", rationale_md: "Why." })
        )
      );
      expect(panel().querySelector("pre")?.textContent).toBe("# s");
      fireEvent.click(tab("Why this skill"));
      expect(within(panel()).getByText("Why.")).toBeTruthy();
      expect(fileReads.calls).toEqual([]);
    });

    it("asks the core's file route for the draft's own SKILL.md and RATIONALE.md", async () => {
      fileReads.real = true;
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, _init?: RequestInit) =>
          new URL(String(input)).searchParams.get("path") === "RATIONALE.md"
            ? new Response(JSON.stringify({ error: "not_found" }), {
                status: 404,
              })
            : new Response("# as installed\n")
      );
      vi.stubGlobal("fetch", fetchMock);
      render(detail(decided({ proposal_id: "p 1" })));
      expect(within(panel()).getByText("Loading…")).toBeTruthy();
      await waitFor(() =>
        expect(panel().querySelector("pre")?.textContent).toBe(
          "# as installed\n"
        )
      );
      fireEvent.click(tab("Why this skill"));
      // No RATIONALE.md: the core's 404.
      expect(await screen.findByText("No rationale was written.")).toBeTruthy();
      const file = "http://127.0.0.1:6174/api/autoskills/proposals/p%201/file";
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
        `${file}?path=SKILL.md`,
        `${file}?path=RATIONALE.md`,
      ]);
    });
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
