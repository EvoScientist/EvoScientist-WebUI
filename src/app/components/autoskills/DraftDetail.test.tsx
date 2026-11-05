// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft, DraftScope } from "@/lib/autoskills";
import { formatFullTime, formatTime } from "@/lib/time";
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

function detail(
  d: Draft,
  over: { canWrite?: boolean; busy?: boolean; projectLabel?: string } = {}
) {
  // Each mount reads with a cache of its own; a rerender keeps it.
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DraftDetail
        draft={d}
        projectLabel={over.projectLabel ?? "EvoSci_test"}
        canWrite={over.canWrite ?? true}
        busy={over.busy ?? false}
        onApprove={onApprove}
        onReject={onReject}
      />
    </SWRConfig>
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
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText("This replaces the installed paper-review.")
    ).toBeTruthy();
    expect(onApprove).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onApprove).not.toHaveBeenCalled();
    // The focus is back on what asked.
    expect(document.activeElement).toBe(approve);

    pickScope("All projects (global)");
    fireEvent.click(approve);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Replace and install",
      })
    );
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(d, "global");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
