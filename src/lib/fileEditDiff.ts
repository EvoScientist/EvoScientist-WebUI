import { structuredPatch } from "diff";
import { TRUNCATION_SUFFIX } from "@/lib/subAgentStepsStore";

export type DiffRow =
  | { kind: "added" | "removed" | "context"; text: string }
  // Between two changes too far apart to share their context lines.
  | { kind: "gap" }
  // What the rows can't show, after them.
  | { kind: "note"; text: string };

/** A row to show, keyed by its place in the diff, or the fold. */
export type ShownRow =
  | { key: number; row: DiffRow }
  | { key: "fold"; hidden: number };

export interface FileEditDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** The args the diff stands for, left out of the args list. */
  replaces: string[];
}

const CONTEXT_LINES = 3;
// Diffing is quadratic in the number of changed lines: two unrelated
// 3000-line texts take over half a second. Past this many it gives up.
const MAX_CHANGED_LINES = 500;
// Each row is drawn: 20,000 rows take 1.5 s to show. A bigger change keeps
// its args.
const MAX_DIFF_ROWS = 2000;
// At most this many rows show before "Show N more lines", the fold included.
const MAX_ROWS = 12;
const HEAD_ROWS = 6;
const TAIL_ROWS = MAX_ROWS - HEAD_ROWS - 1;
// A longer line shows its start until asked: one line of minified JSON or
// base64 would fill the screen.
const MAX_LINE_CHARS = 1000;

const WHITESPACE_NOTE = "Only line endings or trailing whitespace change";
const ADDS_BREAK_NOTE =
  "The new text ends with a line break; the old one didn't";
const DROPS_BREAK_NOTE =
  "The old text ended with a line break; the new one doesn't";

// Lines as the diff counts them: a final newline ends the last line.
function splitLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

const withoutCr = (line: string) => line.replace(/\r$/, "");

const withFinalBreak = (text: string) =>
  text === "" || text.endsWith("\n") ? text : text + "\n";

const trimLineEnds = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

/** Line diff for a deepagents `edit_file` / `write_file` call, or null when
 *  its args aren't there (yet), change nothing, are cut off, or are too big
 *  to show. The args hold only the replaced text, not the file, so there
 *  are no file line numbers; a written file shows as all added, as the tool
 *  doesn't say what it replaced. */
export function fileEditDiff(
  toolName: string,
  args: Record<string, unknown>
): FileEditDiff | null {
  if (toolName === "write_file") {
    const content = args.content;
    if (typeof content !== "string" || content === "") return null;
    if (content.endsWith(TRUNCATION_SUFFIX)) return null;
    const lines = splitLines(content);
    if (lines.length > MAX_DIFF_ROWS) return null;
    return {
      rows: lines.map((line) => ({ kind: "added", text: withoutCr(line) })),
      added: lines.length,
      removed: 0,
      replaces: ["content"],
    };
  }
  if (toolName !== "edit_file") return null;
  const before = args.old_string;
  const after = args.new_string;
  if (typeof before !== "string" || typeof after !== "string") return null;
  // Sub-agent steps restored after a reload keep only the start of long args.
  if (before.endsWith(TRUNCATION_SUFFIX) || after.endsWith(TRUNCATION_SUFFIX))
    return null;
  // An edit's text usually stops mid-file, without a final newline: compared
  // as is, "a" against "a\nb" reads as "a" replaced. Diff whole lines, and
  // say when only one text ends with a line break, which joins or splits the
  // file's next line.
  const oldText = withFinalBreak(before);
  const newText = withFinalBreak(after);
  const notes: DiffRow[] = [];
  if (
    before !== "" &&
    after !== "" &&
    before.endsWith("\n") !== after.endsWith("\n")
  ) {
    notes.push({
      kind: "note",
      text: after.endsWith("\n") ? ADDS_BREAK_NOTE : DROPS_BREAK_NOTE,
    });
  }
  const replaces = ["old_string", "new_string"];
  if (oldText === newText) {
    if (notes.length === 0) return null;
    const lastLines = splitLines(oldText).slice(-CONTEXT_LINES);
    return {
      rows: [
        ...lastLines.map(
          (line): DiffRow => ({
            kind: "context",
            text: withoutCr(line),
          })
        ),
        ...notes,
      ],
      added: 0,
      removed: 0,
      replaces,
    };
  }

  const patch = structuredPatch("", "", oldText, newText, "", "", {
    context: CONTEXT_LINES,
    maxEditLength: MAX_CHANGED_LINES,
  });
  if (!patch) return null;
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  patch.hunks.forEach((hunk, index) => {
    if (index > 0) rows.push({ kind: "gap" });
    for (const line of hunk.lines) {
      const text = withoutCr(line.slice(1));
      if (line[0] === "+") {
        rows.push({ kind: "added", text });
        added += 1;
      } else if (line[0] === "-") {
        rows.push({ kind: "removed", text });
        removed += 1;
      } else if (line[0] === " ") {
        rows.push({ kind: "context", text });
      }
      // Both texts end with a newline, so jsdiff's "\ No newline at end of
      // file" can't come up.
    }
  });
  // The rows read the same: say what changed.
  if (trimLineEnds(oldText) === trimLineEnds(newText)) {
    rows.push({ kind: "note", text: WHITESPACE_NOTE });
  }
  rows.push(...notes);
  if (rows.length > MAX_DIFF_ROWS) return null;
  return { rows, added, removed, replaces };
}

/** The rows to show at first: a long diff keeps its first and last rows and
 *  folds at least two in between. */
export function foldRows(rows: DiffRow[]): ShownRow[] {
  const shown = rows.map((row, key) => ({ key, row }));
  if (rows.length <= MAX_ROWS) return shown;
  const hidden = rows.slice(HEAD_ROWS, rows.length - TAIL_ROWS);
  return [
    ...shown.slice(0, HEAD_ROWS),
    { key: "fold", hidden: hidden.filter((r) => r.kind !== "gap").length },
    ...shown.slice(rows.length - TAIL_ROWS),
  ];
}

/** The start of a line over 1,000 characters and how many characters
 *  (code points) it leaves out, or null for a shorter line. */
export function clipLine(text: string): { head: string; more: number } | null {
  if (text.length <= MAX_LINE_CHARS) return null;
  let end = MAX_LINE_CHARS;
  const last = text.charCodeAt(end - 1);
  // Don't split a surrogate pair.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  let more = 0;
  for (let i = end; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const previous = text.charCodeAt(i - 1);
    // The second half of a pair was counted with the first.
    const pairEnd =
      code >= 0xdc00 &&
      code <= 0xdfff &&
      previous >= 0xd800 &&
      previous <= 0xdbff;
    if (!pairEnd) more += 1;
  }
  return { head: text.slice(0, end), more };
}
