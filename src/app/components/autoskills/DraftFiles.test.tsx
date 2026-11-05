// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft } from "@/lib/autoskills";

// Each file read, by "<path>|<installed>": its answer, and every call made.
const reads = vi.hoisted(() => ({
  answers: new Map<
    string,
    { text: string | null; error: string | null; loading: boolean }
  >(),
  calls: [] as Array<[string | null, string | null, boolean]>,
}));

vi.mock("@/app/hooks/useAutoSkills", () => ({
  useDraftFile: (
    draft: { proposal_id: string } | null,
    path: string | null,
    installed: boolean
  ) => {
    reads.calls.push([draft?.proposal_id ?? null, path, installed]);
    return (
      reads.answers.get(`${path}|${installed}`) ?? {
        text: null,
        error: null,
        loading: true,
      }
    );
  },
}));

import { DraftFiles } from "./DraftFiles";

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

function answer(path: string, installed: boolean, text: string) {
  reads.answers.set(`${path}|${installed}`, {
    text,
    error: null,
    loading: false,
  });
}

const installedReads = () => reads.calls.filter((c) => c[2]);
const fileButton = (path: string) =>
  screen.getByRole("button", { name: new RegExp(`^${path}`) });

beforeEach(() => {
  reads.answers.clear();
  reads.calls = [];
});

describe("DraftFiles", () => {
  it("DraftFiles shows an update's change as a diff against the installed copy", () => {
    const d = draft({
      proposal_id: "paper-review",
      operation: "update",
      target_skill_name: "paper-review",
      install_base: "/home/u/.evoscientist/skills/paper-review",
      files: [
        { path: "SKILL.md", size: 1234, installed: true },
        { path: "scripts/run.py", size: 300, installed: true },
      ],
    });
    answer("SKILL.md", true, "# Review\nold step\nkeep\n");
    answer("SKILL.md", false, "# Review\nnew step\nkeep\n");
    const lines = (p: string) =>
      Array.from({ length: 600 }, (_, i) => `${p}${i}`).join("\n") + "\n";
    answer("scripts/run.py", true, lines("old"));
    answer("scripts/run.py", false, lines("new"));
    render(<DraftFiles draft={d} />);

    // Every file with its size; the first one shows.
    expect(fileButton("SKILL.md").textContent).toContain("1.2 KB");
    expect(fileButton("scripts/run.py").textContent).toContain("300 B");
    expect(fileButton("SKILL.md").getAttribute("aria-current")).toBe("true");

    // The installed copy is the old side, the draft the new one.
    const changes = screen.getByRole("list", { name: "Changes" });
    expect(within(changes).getByText("old step")).toBeTruthy();
    expect(within(changes).getByText("new step")).toBeTruthy();
    expect(changes.textContent).toContain("Removed: old step");
    expect(changes.textContent).toContain("Added: new step");
    expect(reads.calls).toContainEqual(["paper-review", "SKILL.md", true]);
    expect(reads.calls).toContainEqual(["paper-review", "SKILL.md", false]);

    // Too large to diff: said so, with the draft's text.
    fireEvent.click(fileButton("scripts/run.py"));
    expect(fileButton("scripts/run.py").getAttribute("aria-current")).toBe(
      "true"
    );
    expect(screen.queryByRole("list", { name: "Changes" })).toBeNull();
    expect(
      screen.getByText("Too many changes to show as a diff.")
    ).toBeTruthy();
    expect(screen.getByText(/new599/).textContent).toBe(lines("new"));

    // A draft read that failed says so in place.
    reads.answers.set("scripts/run.py|false", {
      text: null,
      error: "This file isn't there any more.",
      loading: false,
    });
    fireEvent.click(fileButton("SKILL.md"));
    fireEvent.click(fileButton("scripts/run.py"));
    expect(screen.getByText("This file isn't there any more.")).toBeTruthy();
    expect(
      screen.queryByText("Too many changes to show as a diff.")
    ).toBeNull();
  });

  it("DraftFiles shows a new file of an update as new", () => {
    const d = draft({
      proposal_id: "paper-review",
      operation: "update",
      target_skill_name: "paper-review",
      install_base: "/home/u/.evoscientist/skills/paper-review",
      files: [
        { path: "SKILL.md", size: 10, installed: true },
        { path: "scripts/verify.py", size: 2_500_000, installed: false },
      ],
    });
    answer("SKILL.md", true, "same\n");
    answer("SKILL.md", false, "same\n");
    answer("scripts/verify.py", false, "print('<b>hi</b>')\n");
    const { container } = render(<DraftFiles draft={d} />);

    expect(fileButton("scripts/verify.py").textContent).toContain("New file");
    expect(fileButton("scripts/verify.py").textContent).toContain("2.39 MB");
    expect(fileButton("SKILL.md").textContent).not.toContain("New file");

    reads.calls = [];
    fireEvent.click(fileButton("scripts/verify.py"));
    // The draft's text, as written (never markup), and no installed read.
    const text = screen.getByText("print('<b>hi</b>')", { exact: false });
    expect(text.tagName).toBe("PRE");
    expect(text.textContent).toBe("print('<b>hi</b>')\n");
    expect(container.querySelector("pre b")).toBeNull();
    expect(installedReads()).toEqual([]);
    expect(screen.queryByRole("list", { name: "Changes" })).toBeNull();
  });

  it("DraftFiles says Unchanged for identical texts", () => {
    const d = draft({
      proposal_id: "paper-review",
      operation: "update",
      install_base: "/home/u/.evoscientist/skills/paper-review",
      files: [{ path: "SKILL.md", size: 10, installed: true }],
    });
    answer("SKILL.md", true, "same\n");
    // Still reading the draft's copy: nothing is decided yet.
    const view = render(<DraftFiles draft={d} />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("Unchanged.")).toBeNull();

    answer("SKILL.md", false, "same\n");
    view.rerender(<DraftFiles draft={{ ...d }} />);
    expect(screen.getByText("Unchanged.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Changes" })).toBeNull();
    expect(
      screen.queryByText("Too many changes to show as a diff.")
    ).toBeNull();
  });

  it("DraftFiles shows a decided update's files without diffs", () => {
    const d = draft({
      proposal_id: "paper-review",
      operation: "update",
      status: "approved",
      approved_at: "2026-11-02T09:00:00Z",
      // Even if a decided draft said a file was installed, nothing is
      // compared: the installed folder is what the approval made.
      files: [
        { path: "SKILL.md", size: 10, installed: true },
        { path: "scripts/verify.py", size: 20, installed: false },
      ],
    });
    answer("SKILL.md", false, "# Paper review\n");
    answer("SKILL.md", true, "# Older\n");
    answer("scripts/verify.py", false, "print(1)\n");
    render(<DraftFiles draft={d} />);

    expect(screen.getByText("# Paper review", { exact: false }).tagName).toBe(
      "PRE"
    );
    fireEvent.click(fileButton("scripts/verify.py"));
    expect(screen.getByText("print(1)", { exact: false }).tagName).toBe("PRE");
    expect(screen.queryByText("New file")).toBeNull();
    expect(screen.queryByRole("list", { name: "Changes" })).toBeNull();
    expect(screen.queryByText("Unchanged.")).toBeNull();
    expect(installedReads()).toEqual([]);
  });

  it("starts each draft on its first file", () => {
    const d = draft({
      proposal_id: "a",
      files: [
        { path: "SKILL.md", size: 1, installed: false },
        { path: "notes.md", size: 1, installed: false },
      ],
    });
    answer("SKILL.md", false, "skill a\n");
    answer("notes.md", false, "notes a\n");
    const view = render(<DraftFiles draft={d} />);
    fireEvent.click(fileButton("notes.md"));
    expect(screen.getByText("notes a", { exact: false })).toBeTruthy();

    const other = draft({
      proposal_id: "b",
      files: [
        { path: "SKILL.md", size: 1, installed: false },
        { path: "notes.md", size: 1, installed: false },
      ],
    });
    view.rerender(<DraftFiles draft={other} />);
    expect(fileButton("SKILL.md").getAttribute("aria-current")).toBe("true");
    expect(reads.calls.at(-1)).toEqual(["b", "SKILL.md", false]);
  });

  it("compares with the installed copy only for the recorded place", () => {
    const note =
      "Changes against the installed copy are shown for the recorded place only.";
    const d = draft({
      proposal_id: "paper-review",
      operation: "update",
      install_base: "/home/u/.evoscientist/skills/paper-review",
      files: [
        { path: "SKILL.md", size: 10, installed: true },
        { path: "scripts/new.py", size: 10, installed: false },
      ],
    });
    answer("SKILL.md", true, "old step\n");
    answer("SKILL.md", false, "new step\n");
    answer("scripts/new.py", false, "print(1)\n");

    // The other place is picked: the core would start from another folder,
    // so nothing is compared and nothing is called new.
    const view = render(
      <DraftFiles
        draft={d}
        compareInstalled={false}
      />
    );
    expect(screen.getByText(note)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Changes" })).toBeNull();
    expect(screen.getByText("new step", { exact: false }).tagName).toBe("PRE");
    expect(screen.queryByText("New file")).toBeNull();
    expect(installedReads()).toEqual([]);

    // Back on the recorded place: the diff and the label return.
    view.rerender(
      <DraftFiles
        draft={d}
        compareInstalled
      />
    );
    expect(screen.queryByText(note)).toBeNull();
    expect(screen.getByRole("list", { name: "Changes" })).toBeTruthy();
    expect(fileButton("scripts/new.py").textContent).toContain("New file");
    expect(installedReads()).toContainEqual(["paper-review", "SKILL.md", true]);
  });

  it("shows the draft's text when only the installed copy can't be read", () => {
    const d = draft({
      proposal_id: "paper-review",
      operation: "update",
      install_base: "/home/u/.evoscientist/skills/paper-review",
      files: [
        { path: "SKILL.md", size: 10, installed: true },
        { path: "notes.md", size: 10, installed: true },
      ],
    });
    reads.answers.set("SKILL.md|true", {
      text: null,
      error: "This file isn't text, so it isn't shown.",
      loading: false,
    });
    answer("SKILL.md", false, "new step\n");
    render(<DraftFiles draft={d} />);
    expect(
      screen.getByText(
        "Couldn't read the installed copy, so only the draft is shown."
      )
    ).toBeTruthy();
    expect(screen.getByText("new step", { exact: false }).tagName).toBe("PRE");
    expect(
      screen.queryByText("This file isn't text, so it isn't shown.")
    ).toBeNull();

    // The draft's own read failing still says so in place of the file.
    answer("notes.md", true, "old\n");
    reads.answers.set("notes.md|false", {
      text: null,
      error: "This file isn't there any more.",
      loading: false,
    });
    fireEvent.click(fileButton("notes.md"));
    expect(screen.getByText("This file isn't there any more.")).toBeTruthy();
    expect(
      screen.queryByText(
        "Couldn't read the installed copy, so only the draft is shown."
      )
    ).toBeNull();
  });

  it("reads no installed copy without an install base", () => {
    const d = draft({
      proposal_id: "paper-review",
      operation: "update",
      install_base: null,
      files: [{ path: "SKILL.md", size: 10, installed: true }],
    });
    answer("SKILL.md", false, "new step\n");
    answer("SKILL.md", true, "old step\n");
    render(<DraftFiles draft={d} />);
    expect(screen.getByText("new step", { exact: false }).tagName).toBe("PRE");
    expect(screen.queryByRole("list", { name: "Changes" })).toBeNull();
    expect(installedReads()).toEqual([]);
  });

  it("marks a file too large to show here before it is opened", () => {
    const d = draft({
      proposal_id: "x",
      files: [
        { path: "SKILL.md", size: 10, installed: false },
        { path: "edge.txt", size: 1_048_576, installed: false },
        { path: "data.bin", size: 1_048_577, installed: false },
      ],
    });
    render(<DraftFiles draft={d} />);
    expect(fileButton("data.bin").textContent).toContain(
      "too large to show here"
    );
    // The core shows a file of up to 1,048,576 bytes.
    expect(fileButton("edge.txt").textContent).not.toContain("too large");
    expect(fileButton("SKILL.md").textContent).not.toContain("too large");
  });

  it("shows sizes in B, KB and MB without a 1024.0 KB", () => {
    const sizes = [0, 1023, 1024, 1_048_524, 1_048_575, 1_048_576];
    const d = draft({
      proposal_id: "x",
      files: sizes.map((size, i) => ({
        path: `f${i}.txt`,
        size,
        installed: false,
      })),
    });
    render(<DraftFiles draft={d} />);
    const shown = sizes.map((_, i) =>
      fileButton(`f${i}.txt`).textContent?.replace(`f${i}.txt`, "")
    );
    expect(shown).toEqual([
      "0 B",
      "1023 B",
      "1.0 KB",
      "1023.9 KB",
      "1.00 MB",
      "1.00 MB",
    ]);
  });

  it("rounds MB up to two decimals, so a file over the limit never reads 1.00 MB", () => {
    const sizes = [1_048_577, 1_073_308, 2_097_152, 2_500_000];
    const d = draft({
      proposal_id: "x",
      files: sizes.map((size, i) => ({
        path: `f${i}.txt`,
        size,
        installed: false,
      })),
    });
    render(<DraftFiles draft={d} />);
    // The size is the row's last part, after "too large to show here".
    const shown = sizes.map(
      (_, i) => fileButton(`f${i}.txt`).lastElementChild?.textContent
    );
    expect(shown).toEqual(["1.01 MB", "1.03 MB", "2.00 MB", "2.39 MB"]);
  });
});
