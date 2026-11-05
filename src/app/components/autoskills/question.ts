import { useState } from "react";

/** What an approval's question says: its title, its sentences and the
 *  button that answers it. */
export interface Question {
  title: string;
  description: string;
  action: string;
}

function sameWords(a: Question, b: Question): boolean {
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.action === b.action
  );
}

/** The words a question's dialog shows: `live` while it is open; while it
 *  fades out (200 ms, still on the page), the words it had open, whatever
 *  changes meanwhile (a decision's answers prune the selection, the pane
 *  shows another draft). */
export function useShownQuestion(open: boolean, live: Question): Question {
  const [held, setHeld] = useState(live);
  if (open && !sameWords(held, live)) setHeld(live);
  return open ? live : held;
}
