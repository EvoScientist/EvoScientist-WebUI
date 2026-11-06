import { useState } from "react";
import {
  MAX_SHOWN_BYTES,
  sizeText,
  type UnshowableFile,
} from "@/lib/autoskills";

/** The files an approval would install unseen, under the question's
 *  sentences: an opening line, one group per draft (named only when there
 *  are several) and a closing line. */
export interface FileSection {
  intro: string;
  groups: ReadonlyArray<{ name: string | null; lines: readonly string[] }>;
  outro: string;
}

/** What an approval's question says: its title, its sentences, the files
 *  it installs unseen and the button that answers it. */
export interface Question {
  title: string;
  description: string;
  action: string;
  files?: FileSection;
}

function sameWords(a: Question, b: Question): boolean {
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.action === b.action &&
    JSON.stringify(a.files) === JSON.stringify(b.files)
  );
}

/** What an approval says when, once its drafts' files are checked, it
 *  can't go as clicked: nothing is sent. */
export const APPROVE_CHANGED =
  "Nothing was installed: the drafts changed while their files were checked. Approve again.";
/** The same, while another decision or an Undo is still being saved. */
export const APPROVE_BUSY =
  "Another change is still being saved. Approve again.";

/** The words a question's dialog shows: `live` while it is open; while it
 *  fades out (200 ms, still on the page), the words it had open, whatever
 *  changes meanwhile (a decision's answers prune the selection, the pane
 *  shows another draft). */
export function useShownQuestion(open: boolean, live: Question): Question {
  const [held, setHeld] = useState(live);
  if (open && !sameWords(held, live)) setHeld(live);
  return open ? live : held;
}

/** One file the page can't show, as the question lists it. A size only for
 *  a file listed over the limit: one listed within it whose read answered
 *  413 has grown since, and its listed size would say it fits. */
function fileLine(file: UnshowableFile): string {
  switch (file.reason) {
    case "too_large":
      return file.size > MAX_SHOWN_BYTES
        ? `${file.path} (${sizeText(file.size)}) — too large to show`
        : `${file.path} — too large to show`;
    case "not_text":
      return `${file.path} — not text`;
    default:
      return `${file.path} — couldn't be checked`;
  }
}

/** The files the drafts of an approval hold that the page can't show;
 *  undefined when none does. */
export function fileSection(
  holders: ReadonlyArray<{ name: string; files: readonly UnshowableFile[] }>
): FileSection | undefined {
  const held = holders.filter((h) => h.files.length > 0);
  if (held.length === 0) return undefined;
  const one = held.length === 1;
  return {
    intro: one
      ? `${held[0].name} holds files this page can't show:`
      : "Some drafts hold files this page can't show:",
    groups: held.map((h) => ({
      name: one ? null : h.name,
      lines: h.files.map(fileLine),
    })),
    outro: one
      ? "They are installed with the skill."
      : "They are installed with their skills.",
  };
}

/** The question before an approval whose only concern is files the page
 *  can't show. */
export function filesQuestion(files: FileSection | undefined): Question {
  return {
    title: "Install files you haven't seen?",
    description: "",
    action: "Install anyway",
    files,
  };
}

/** `question` with the files under its sentences; the same question when
 *  there are none. */
export function withFiles(
  question: Question,
  files: FileSection | undefined
): Question {
  return files ? { ...question, files } : question;
}
