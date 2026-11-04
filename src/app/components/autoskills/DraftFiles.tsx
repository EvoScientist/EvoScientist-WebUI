"use client";

import { useMemo, useState } from "react";
import { LineDiff } from "@/app/components/LineDiff";
import { useDraftFile } from "@/app/hooks/useAutoSkills";
import type { Draft, DraftFile } from "@/lib/autoskills";
import { textFileDiff } from "@/lib/fileEditDiff";
import { cn } from "@/lib/utils";

// Every file an approval copies, one shown at a time: a pending update's
// installed file as a diff against the installed copy, any other file as
// the draft's text. Texts are untrusted: plain text, never markup.
// The installed copy is the one the core found for the draft's recorded
// place (install_base); for another place it would start from another
// folder, so then nothing is compared.

/** A file's text as written: monospace and wrapped, never markup. */
export function FileText({ text }: { text: string }) {
  return (
    <pre className="m-0 whitespace-pre-wrap break-words rounded-sm border border-border p-3 font-mono text-xs leading-5 text-foreground">
      {text}
    </pre>
  );
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  // MB before the rounded KB would read 1024.0.
  const kb = (bytes / 1024).toFixed(1);
  if (Number(kb) < 1024) return `${kb} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Reading() {
  return <p className="text-sm text-muted-foreground">Loading…</p>;
}

function ReadError({ message }: { message: string }) {
  return <p className="text-sm text-destructive">{message}</p>;
}

/** The draft's own copy of a file. */
function DraftText({ draft, path }: { draft: Draft; path: string }) {
  const { text, error } = useDraftFile(draft, path, false);
  if (error) return <ReadError message={error} />;
  if (text === null) return <Reading />;
  return <FileText text={text} />;
}

/** A pending update's file the skill already has: what the approval
 *  changes in it. */
function FileChange({ draft, path }: { draft: Draft; path: string }) {
  const installed = useDraftFile(draft, path, true);
  const proposed = useDraftFile(draft, path, false);
  const before = installed.text;
  const after = proposed.text;
  // null both when the texts are equal and when they are too large to diff.
  const diff = useMemo(
    () =>
      before !== null && after !== null && before !== after
        ? textFileDiff(before, after)
        : null,
    [before, after]
  );
  if (proposed.error) return <ReadError message={proposed.error} />;
  if (after === null) return <Reading />;
  // Without the installed copy the draft's text still shows.
  if (installed.error) {
    return (
      <>
        <p className="mb-2 text-sm text-muted-foreground">
          Couldn&apos;t read the installed copy, so only the draft is shown.
        </p>
        <FileText text={after} />
      </>
    );
  }
  if (before === null) return <Reading />;
  if (before === after) {
    return <p className="text-sm text-muted-foreground">Unchanged.</p>;
  }
  if (diff) {
    return (
      <LineDiff
        diff={diff}
        heading="Changes"
      />
    );
  }
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground">
        Too many changes to show as a diff.
      </p>
      <FileText text={after} />
    </>
  );
}

export function DraftFiles({
  draft,
  compareInstalled = true,
}: {
  draft: Draft;
  /** Whether the draft goes where it records (the place `install_base`
   *  was found for); false while another place is picked. */
  compareInstalled?: boolean;
}) {
  // The file picked, for this draft only: another draft starts on its first.
  const [picked, setPicked] = useState<{ id: string; path: string } | null>(
    null
  );
  const files = draft.files;
  const shown: DraftFile | undefined =
    (picked?.id === draft.proposal_id &&
      files.find((f) => f.path === picked.path)) ||
    files[0];
  // The core says what is installed for pending drafts only; a decided
  // draft's files are shown as the draft has them.
  const pending = draft.status === "pending";
  const update = pending && draft.operation === "update";
  const compare = update && compareInstalled && draft.install_base !== null;
  const isNew = (f: DraftFile) => compare && !f.installed;

  if (!shown) {
    return (
      <p className="text-sm text-muted-foreground">This draft has no files.</p>
    );
  }

  return (
    <div className="space-y-3">
      {update && !compareInstalled && (
        <p className="text-sm text-muted-foreground">
          Changes against the installed copy are shown for the recorded place
          only.
        </p>
      )}
      <ul
        aria-label="Files"
        className="m-0 list-none rounded-md border border-border p-0"
      >
        {files.map((f) => {
          const current = f.path === shown.path;
          return (
            <li
              key={f.path}
              className="mb-0 border-b border-border last:border-b-0"
            >
              <button
                type="button"
                aria-current={current ? "true" : undefined}
                onClick={() =>
                  setPicked({ id: draft.proposal_id, path: f.path })
                }
                className={cn(
                  "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:min-h-11",
                  current && "bg-[var(--brand-soft)]"
                )}
              >
                <span className="min-w-0 flex-1 break-all font-mono text-xs">
                  {f.path}
                </span>
                {isNew(f) && (
                  <span className="shrink-0 text-xs text-[var(--brand)]">
                    New file
                  </span>
                )}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {sizeText(f.size)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div>
        <h4 className="mb-2 break-all font-mono text-xs font-medium text-muted-foreground">
          {shown.path}
        </h4>
        {compare && shown.installed ? (
          <FileChange
            key={`${draft.proposal_id}\n${shown.path}`}
            draft={draft}
            path={shown.path}
          />
        ) : (
          <DraftText
            key={`${draft.proposal_id}\n${shown.path}`}
            draft={draft}
            path={shown.path}
          />
        )}
      </div>
    </div>
  );
}
