import { describe, expect, it } from "vitest";
import { clipLine, fileEditDiff, foldRows, type DiffRow } from "./fileEditDiff";
import { TRUNCATION_SUFFIX } from "./subAgentStepsStore";

// deepagents' tools: edit_file(file_path, old_string, new_string,
// replace_all) and write_file(file_path, content).
describe("fileEditDiff", () => {
  it("diffs an edit's old and new text line by line, with context", () => {
    const diff = fileEditDiff("edit_file", {
      file_path: "/ws/train.py",
      old_string: "lr = 0.01\nepochs = 10\nbatch = 32",
      new_string: "lr = 0.01\nepochs = 50\nbatch = 32",
    });

    expect(diff).toEqual({
      rows: [
        { kind: "context", text: "lr = 0.01" },
        { kind: "removed", text: "epochs = 10" },
        { kind: "added", text: "epochs = 50" },
        { kind: "context", text: "batch = 32" },
      ],
      added: 1,
      removed: 1,
      replaces: ["old_string", "new_string"],
    });
  });

  it("keeps three lines of context and marks the gap between far-apart changes", () => {
    const old = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const next = ["A", "b", "c", "d", "e", "f", "g", "h", "i", "J"].join("\n");

    const diff = fileEditDiff("edit_file", {
      old_string: old,
      new_string: next,
    });

    expect(diff?.rows).toEqual([
      { kind: "removed", text: "a" },
      { kind: "added", text: "A" },
      { kind: "context", text: "b" },
      { kind: "context", text: "c" },
      { kind: "context", text: "d" },
      { kind: "gap" },
      { kind: "context", text: "g" },
      { kind: "context", text: "h" },
      { kind: "context", text: "i" },
      { kind: "removed", text: "j" },
      { kind: "added", text: "J" },
    ]);
  });

  // An edit's text usually stops mid-file, without a final newline; compared
  // as is, its last line would read as replaced by itself.
  it("shows lines added after an unchanged last line as added only", () => {
    const diff = fileEditDiff("edit_file", {
      old_string: "import os\nimport sys",
      new_string: "import os\nimport sys\nimport re",
    });

    expect(diff?.rows).toEqual([
      { kind: "context", text: "import os" },
      { kind: "context", text: "import sys" },
      { kind: "added", text: "import re" },
    ]);
    expect(diff?.added).toBe(1);
    expect(diff?.removed).toBe(0);
  });

  // Only one text ending with a line break joins or splits the file's next
  // line, which the rows can't show.
  const ADDS_BREAK = {
    kind: "note",
    text: "The new text ends with a line break; the old one didn't",
  };
  const DROPS_BREAK = {
    kind: "note",
    text: "The old text ended with a line break; the new one doesn't",
  };

  it("shows a line added after an unchanged CRLF line as added only", () => {
    const diff = fileEditDiff("edit_file", {
      old_string: "a\r\nb",
      new_string: "a\r\nb\r\nc",
    });

    expect(diff?.rows).toEqual([
      { kind: "context", text: "a" },
      { kind: "context", text: "b" },
      { kind: "added", text: "c" },
    ]);
    expect(diff?.added).toBe(1);
    expect(diff?.removed).toBe(0);
  });

  it("compares whole lines, and says when only the new text ends with a line break", () => {
    const diff = fileEditDiff("edit_file", {
      old_string: "x = 1\ny = 2",
      new_string: "x = 1\ny = 3\n",
    });

    expect(diff?.rows).toEqual([
      { kind: "context", text: "x = 1" },
      { kind: "removed", text: "y = 2" },
      { kind: "added", text: "y = 3" },
      ADDS_BREAK,
    ]);
  });

  it("says when an edit drops the old text's final line break", () => {
    const diff = fileEditDiff("edit_file", {
      old_string: "def f():\n    pass\n",
      new_string: "def f():\n    return 1",
    });

    expect(diff?.rows).toEqual([
      { kind: "context", text: "def f():" },
      { kind: "removed", text: "    pass" },
      { kind: "added", text: "    return 1" },
      DROPS_BREAK,
    ]);
  });

  it("shows the last lines and says so when an edit only drops the final line break", () => {
    expect(
      fileEditDiff("edit_file", {
        old_string: "a\nb\nc\nd\n",
        new_string: "a\nb\nc\nd",
      })
    ).toEqual({
      rows: [
        { kind: "context", text: "b" },
        { kind: "context", text: "c" },
        { kind: "context", text: "d" },
        DROPS_BREAK,
      ],
      added: 0,
      removed: 0,
      replaces: ["old_string", "new_string"],
    });
  });

  it("says so when an edit only adds a final line break", () => {
    expect(
      fileEditDiff("edit_file", { old_string: "d", new_string: "d\n" })?.rows
    ).toEqual([{ kind: "context", text: "d" }, ADDS_BREAK]);
  });

  it("shows CRLF lines without their carriage return", () => {
    const diff = fileEditDiff("edit_file", {
      old_string: "a\r\nb\r\n",
      new_string: "a\r\nc\r\n",
    });

    expect(diff?.rows).toEqual([
      { kind: "context", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "c" },
    ]);
  });

  it.each([
    ["line endings", "a\r\nb\r\n", "a\nb\n", ["a", "b"], ["a", "b"]],
    ["trailing spaces", "x = 1 \n", "x = 1\n", ["x = 1 "], ["x = 1"]],
  ])("says so when only %s change", (_, before, after, removed, added) => {
    const diff = fileEditDiff("edit_file", {
      old_string: before,
      new_string: after,
    });

    expect(diff?.rows).toEqual([
      ...removed.map((text) => ({ kind: "removed", text })),
      ...added.map((text) => ({ kind: "added", text })),
      {
        kind: "note",
        text: "Only line endings or trailing whitespace change",
      },
    ]);
  });

  // The line break added for the diff follows the texts' own line endings.
  it.each([
    ["a\r\nb", "a\r\nb\r\n", ["a", "b"]],
    ["b", "b\r\n", ["b"]],
  ])(
    "says so when a CRLF edit only adds a final line break (%j → %j)",
    (before, after, lastLines) => {
      expect(
        fileEditDiff("edit_file", { old_string: before, new_string: after })
      ).toEqual({
        rows: [
          ...lastLines.map((text) => ({ kind: "context", text })),
          ADDS_BREAK,
        ],
        added: 0,
        removed: 0,
        replaces: ["old_string", "new_string"],
      });
    }
  );

  // Mixed line endings: a text without a final break gets the break the
  // other text has at that point, so an unchanged last line stays unchanged.
  const ctx = (text: string) => ({ kind: "context", text });
  const del = (text: string) => ({ kind: "removed", text });
  const add = (text: string) => ({ kind: "added", text });
  const WS = {
    kind: "note",
    text: "Only line endings or trailing whitespace change",
  };
  it.each([
    ["a\r\nb", "a\r\nb\n", [ctx("a"), ctx("b"), ADDS_BREAK], 0, 0],
    ["a\r\nb\n", "a\r\nb", [ctx("a"), ctx("b"), DROPS_BREAK], 0, 0],
    [
      "a\r\nb\nc",
      "a\r\nb\nc\n",
      [ctx("a"), ctx("b"), ctx("c"), ADDS_BREAK],
      0,
      0,
    ],
    ["a\r\nb", "a\r\nb\nc", [ctx("a"), ctx("b"), add("c")], 1, 0],
    ["a\r\nb", "a\nb\n", [del("a"), add("a"), ctx("b"), WS, ADDS_BREAK], 1, 1],
    ["a\nb", "a\r\nb", [del("a"), add("a"), ctx("b"), WS], 1, 1],
    ["a\r\nb\r\nc", "a\r\nb", [ctx("a"), ctx("b"), del("c")], 0, 1],
    ["a\r\nb", "c\r\nb\r\n", [del("a"), add("c"), ctx("b"), ADDS_BREAK], 1, 1],
    ["c\r\nb\r\n", "a\r\nb", [del("c"), add("a"), ctx("b"), DROPS_BREAK], 1, 1],
    ["a\nb", "A\nb\nc", [del("a"), add("A"), ctx("b"), add("c")], 2, 1],
    ["b", "Z\r\nb\r\nc", [add("Z"), ctx("b"), add("c")], 2, 0],
    ["Z\r\nb\r\nc", "b", [del("Z"), ctx("b"), del("c")], 0, 2],
    ["a\r\nb", "A\r\nb\r\nc", [del("a"), add("A"), ctx("b"), add("c")], 2, 1],
    [
      "a\r\nb",
      "Z\r\na\r\nb\r\nc",
      [add("Z"), ctx("a"), ctx("b"), add("c")],
      2,
      0,
    ],
  ])("diffs %j → %j line by line", (before, after, rows, added, removed) => {
    expect(
      fileEditDiff("edit_file", { old_string: before, new_string: after })
    ).toEqual({
      rows,
      added,
      removed,
      replaces: ["old_string", "new_string"],
    });
  });

  it("adds no line-break note to text inserted into an empty old text", () => {
    expect(
      fileEditDiff("edit_file", { old_string: "", new_string: "x\n" })?.rows
    ).toEqual([{ kind: "added", text: "x" }]);
  });

  it("adds no whitespace note when lines only move", () => {
    const diff = fileEditDiff("edit_file", {
      old_string: "import sys\nimport os",
      new_string: "import os\nimport sys",
    });

    expect(diff?.rows.some((r) => r.kind === "note")).toBe(false);
  });

  it("adds no note when a blank line is removed", () => {
    const diff = fileEditDiff("edit_file", {
      old_string: "a\n\nb\n",
      new_string: "a\nb\n",
    });

    expect(diff?.removed).toBe(1);
    expect(diff?.rows.some((r) => r.kind === "note")).toBe(false);
  });

  it("shows a written file as all added lines", () => {
    expect(
      fileEditDiff("write_file", {
        file_path: "/ws/notes.md",
        content: "# Notes\r\n\nfirst\n",
      })
    ).toEqual({
      rows: [
        { kind: "added", text: "# Notes" },
        { kind: "added", text: "" },
        { kind: "added", text: "first" },
      ],
      added: 3,
      removed: 0,
      replaces: ["content"],
    });
  });

  const numbered = (n: number) =>
    Array.from({ length: n }, (_, i) => `row ${i}`).join("\n");

  it("shows a written file of up to 2,000 lines", () => {
    expect(fileEditDiff("write_file", { content: numbered(2000) })?.added).toBe(
      2000
    );
  });

  // Diffing long texts that differ a lot is quadratic: past 500 changed
  // lines the diff gives up.
  const interleaved = (pairs: number) => {
    const before: string[] = [];
    const after: string[] = [];
    for (let i = 0; i < pairs; i++) {
      before.push(`same ${i}`, `old ${i}`);
      after.push(`same ${i}`, `new ${i}`);
    }
    return { before: before.join("\n"), after: after.join("\n") };
  };

  it("diffs an edit of up to 500 changed lines", () => {
    const { before, after } = interleaved(200);

    const diff = fileEditDiff("edit_file", {
      old_string: before,
      new_string: after,
    });

    expect(diff?.removed).toBe(200);
    expect(diff?.added).toBe(200);
    expect(diff?.rows.some((r) => r.kind === "context")).toBe(true);
  });

  // One changed line every eight: each change makes its own hunk of about
  // eight rows.
  const spread = (changes: number) => {
    const before: string[] = [];
    const after: string[] = [];
    for (let i = 0; i < changes; i++) {
      before.push(`old ${i}`);
      after.push(`new ${i}`);
      for (let j = 0; j < 7; j++) {
        before.push(`same ${i}.${j}`);
        after.push(`same ${i}.${j}`);
      }
    }
    return { old_string: before.join("\n"), new_string: after.join("\n") };
  };

  it("diffs an edit of up to 2,000 rows", () => {
    const diff = fileEditDiff("edit_file", spread(200));

    expect(diff?.rows.length).toBeGreaterThan(1700);
    expect(diff?.rows.length).toBeLessThanOrEqual(2000);
  });

  it.each([
    ["edit_file", { old_string: "a" }],
    ["edit_file", { old_string: "a", new_string: 3 }],
    ["edit_file", { old_string: "same", new_string: "same" }],
    ["write_file", { file_path: "/ws/x" }],
    ["write_file", { file_path: "/ws/x", content: "" }],
    ["read_file", { file_path: "/ws/x" }],
  ])("has nothing to show for %s with %j", (name, args) => {
    expect(fileEditDiff(name, args)).toBeNull();
  });

  // Too big to show as a diff, or cut off: the args show as they are.
  it("has nothing to show past 500 changed lines", () => {
    const { before, after } = interleaved(300);

    expect(
      fileEditDiff("edit_file", { old_string: before, new_string: after })
    ).toBeNull();
  });

  // One hunk of exactly 2,000 rows: 250 changed lines, six unchanged lines
  // between each, three before and after.
  const fullHunk = () => {
    const before = ["p0", "p1", "p2"];
    const after = ["p0", "p1", "p2"];
    for (let i = 0; i < 250; i++) {
      before.push(`old ${i}`);
      after.push(`new ${i}`);
      for (let j = 0; j < (i < 249 ? 6 : 3); j++) {
        before.push(`same ${i}.${j}`);
        after.push(`same ${i}.${j}`);
      }
    }
    return { before: before.join("\n"), after: after.join("\n") };
  };

  it("counts a note toward the 2,000 rows", () => {
    const { before, after } = fullHunk();

    expect(
      fileEditDiff("edit_file", { old_string: before, new_string: after })?.rows
    ).toHaveLength(2000);
    expect(
      fileEditDiff("edit_file", {
        old_string: before + "\n",
        new_string: after,
      })
    ).toBeNull();
  });

  it("has nothing to show past 2,000 rows", () => {
    expect(fileEditDiff("edit_file", spread(250))).toBeNull();
    expect(fileEditDiff("write_file", { content: numbered(2001) })).toBeNull();
  });

  // Sub-agent steps restored after a reload keep only the start of long args.
  it.each([
    ["edit_file", { old_string: "a", new_string: "b" + TRUNCATION_SUFFIX }],
    ["edit_file", { old_string: "a" + TRUNCATION_SUFFIX, new_string: "b" }],
    ["write_file", { content: "a\nb" + TRUNCATION_SUFFIX }],
  ])("has nothing to show for cut-off args of %s", (name, args) => {
    expect(fileEditDiff(name, args)).toBeNull();
  });
});

describe("foldRows", () => {
  const rows = (n: number): DiffRow[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: "added",
      text: `line ${i + 1}`,
    }));
  const keyed = (all: DiffRow[], from: number, to = all.length) =>
    all.slice(from, to).map((row, i) => ({ key: from + i, row }));

  it("shows up to twelve rows as they are", () => {
    expect(foldRows(rows(12))).toEqual(keyed(rows(12), 0));
  });

  it("folds the middle of a longer diff, so twelve rows show with the fold", () => {
    const all = rows(20);

    expect(foldRows(all)).toEqual([
      ...keyed(all, 0, 6),
      { key: "fold", hidden: 9 },
      ...keyed(all, 15),
    ]);
  });

  it("never folds away a single row", () => {
    const all = rows(13);

    expect(foldRows(all)).toEqual([
      ...keyed(all, 0, 6),
      { key: "fold", hidden: 2 },
      ...keyed(all, 8),
    ]);
  });

  it("counts the folded lines, not the gaps between changes", () => {
    const all: DiffRow[] = [...rows(8), { kind: "gap" }, ...rows(8)];

    const folded = foldRows(all);

    expect(folded[6]).toEqual({ key: "fold", hidden: 5 });
    expect(folded).toHaveLength(12);
  });
});

describe("clipLine", () => {
  it("leaves a line of up to 1,000 characters whole", () => {
    expect(clipLine("x".repeat(1000))).toBeNull();
  });

  it("cuts a longer line at 1,000 characters and counts the rest", () => {
    expect(clipLine("x".repeat(1000) + "y".repeat(2500))).toEqual({
      head: "x".repeat(1000),
      more: 2500,
    });
  });

  it("counts a lone low surrogate as a character", () => {
    expect(clipLine("x".repeat(1000) + "\udc00")?.more).toBe(1);
  });

  it("keeps a character outside the BMP whole at the cut", () => {
    expect(clipLine("x".repeat(999) + "😀" + "z".repeat(10))).toEqual({
      head: "x".repeat(999),
      more: 11,
    });
  });
});
