"use client";

import { useId, useRef, useState } from "react";
import { useQueryState } from "nuqs";
import useSWR from "swr";
import { DraftFiles, FileText } from "@/app/components/autoskills/DraftFiles";
import { focusFirst } from "@/app/components/autoskills/focus";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { installedLabel, type Draft, type DraftScope } from "@/lib/autoskills";
import { INPUT_LIKE_TRIGGER, LIST_MAX_HEIGHT } from "@/lib/fieldStyles";
import { formatFullTime, formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useProjects } from "@/providers/ProjectsProvider";

// The open draft: what it is, its files as written, why EvoMemory drafted
// it and from what, and for a pending one where to install it and the
// decision. Agent text is untrusted: files are plain text, the rationale
// goes through the Markdown pipeline's sanitizer.

type TabKey = "skill" | "why" | "sources" | "files";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "skill", label: "SKILL.md" },
  { key: "why", label: "Why this skill" },
  { key: "sources", label: "Where it came from" },
  { key: "files", label: "Files" },
];

const TRUNCATED = "Showing the first 200,000 characters.";

const CHIP = "rounded-full border px-2 py-0.5 text-xs";
const PLAIN_CHIP = cn(CHIP, "border-border text-muted-foreground");

export interface DraftDetailProps {
  draft: Draft;
  projectLabel: string;
  canWrite: boolean;
  busy: boolean;
  onApprove(draft: Draft, scope: DraftScope): void;
  onReject(draft: Draft): void;
  /** Where the focus goes when the question closes and neither its Approve
   *  nor this pane is left to take it (the draft left the list meanwhile). */
  focusFallback?: () => HTMLElement | null | undefined;
}

/** This machine's observations' summaries by id. */
async function fetchObservationSummaries(): Promise<Map<string, string>> {
  const res = await fetch("/api/memory/observations", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`GET /api/memory/observations answered ${res.status}`);
  }
  const body = (await res.json()) as { nodes?: unknown };
  const summaries = new Map<string, string>();
  if (!Array.isArray(body.nodes)) return summaries;
  for (const node of body.nodes as Array<Record<string, unknown> | null>) {
    if (
      node &&
      typeof node.id === "string" &&
      typeof node.summary === "string" &&
      node.summary.trim()
    ) {
      summaries.set(node.id, node.summary);
    }
  }
  return summaries;
}

/** The summaries, read once per page (and again after a failed read, the
 *  next time they are wanted); undefined until read or when it failed, and
 *  the ids are shown instead. */
function useObservationSummaries(
  wanted: boolean
): Map<string, string> | undefined {
  const { data } = useSWR(
    wanted ? "memory-observations" : null,
    fetchObservationSummaries,
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    }
  );
  return data;
}

/** "Where it came from": one button per source observation, which opens
 *  it in Memory › Knowledge. The summaries and the Memory view are this
 *  machine's, so only while the page and the backend share it; otherwise
 *  (another machine, or not known yet) the ids alone. */
function Sources({ draft, here }: { draft: Draft; here: boolean }) {
  const ids = draft.source_observation_ids;
  const summaries = useObservationSummaries(here && ids.length > 0);
  const [, setView] = useQueryState("view");
  const [, setMemoryTab] = useQueryState("memoryTab");
  const [, setMemoryObs] = useQueryState("memoryObs");
  const [, setMemoryExec] = useQueryState("memoryExec");

  if (ids.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No source observations were recorded.
      </p>
    );
  }
  if (!here) {
    return (
      <>
        <p className="mb-2 text-sm text-muted-foreground">
          These observations are on the machine that runs EvoScientist.
        </p>
        <ul className="m-0 list-none p-0">
          {ids.map((id) => (
            <li
              key={id}
              className="mb-0 break-all px-2 py-1.5 font-mono text-xs"
            >
              {id}
            </li>
          ))}
        </ul>
      </>
    );
  }
  const open = (id: string) => {
    void setMemoryTab("knowledge");
    void setMemoryObs(id);
    // An execution in the address would take Memory to History instead.
    void setMemoryExec(null);
    void setView("memory");
  };
  return (
    <ul className="m-0 list-none p-0">
      {ids.map((id) => (
        <li
          key={id}
          className="mb-0"
        >
          <button
            type="button"
            title="Opens it in Memory › Knowledge"
            onClick={() => open(id)}
            className="w-full break-words rounded-md px-2 py-1.5 text-left text-sm text-[var(--brand)] hover:bg-accent hover:underline focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
          >
            {summaries?.get(id) ?? id}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function DraftDetail({
  draft,
  projectLabel,
  canWrite,
  busy,
  onApprove,
  onReject,
  focusFallback,
}: DraftDetailProps) {
  const pending = draft.status === "pending";
  const [tab, setTab] = useState<TabKey>("skill");
  // Whether the page and the backend share this machine.
  const here = useProjects().files === "here";

  // This version of the draft: a run that rewrites a pending draft in place
  // keeps its id and gives it a new updated_at (and maybe another scope).
  const version = JSON.stringify([draft.proposal_id, draft.updated_at]);
  // Where to install: each draft opened, and each rewrite, starts at the
  // scope it records.
  const [pick, setPick] = useState<{ version: string; scope: DraftScope }>({
    version,
    scope: draft.scope,
  });
  // The question before an update replaces the installed skill, for this
  // version only: it doesn't come back when the draft is opened again, and
  // a rewrite takes it away.
  const [confirmingVersion, setConfirmingVersion] = useState<string | null>(
    null
  );
  if (pick.version !== version) {
    setPick({ version, scope: draft.scope });
    setConfirmingVersion(null);
  }
  const scope = pick.version === version ? pick.scope : draft.scope;

  const confirming = pending && confirmingVersion === version;

  const baseId = useId();
  const tabId = (key: TabKey) => `${baseId}-tab-${key}`;
  const panelId = `${baseId}-panel`;
  const scopeId = `${baseId}-scope`;
  const errorId = `${baseId}-install-error`;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  // The tabs pattern: one tab stop; arrows (wrapping), Home and End move
  // and show.
  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    let to: number;
    switch (e.key) {
      case "ArrowRight":
        to = index + 1;
        break;
      case "ArrowLeft":
        to = index - 1;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = TABS.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    to = (to + TABS.length) % TABS.length;
    setTab(TABS[to].key);
    tabRefs.current[to]?.focus();
  };

  const off = !canWrite || busy;
  const replaces = draft.target_skill_name ?? draft.skill_name;
  const approve = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (off) return;
    if (draft.operation === "update") {
      invokerRef.current = e.currentTarget;
      setConfirmingVersion(version);
    } else {
      onApprove(draft, scope);
    }
  };
  const confirmReplace = () => {
    if (off) return;
    setConfirmingVersion(null);
    onApprove(draft, scope);
  };

  // The recorded scope's refusal; another scope's is only known by trying.
  const installError =
    pending && scope === draft.scope && draft.install_error
      ? draft.install_error
      : null;

  // The sources and the files are buttons, unless there are none (or the
  // sources are another machine's: then they are plain ids).
  const panelHoldsNoButtons =
    tab === "skill" ||
    tab === "why" ||
    (tab === "sources" &&
      (draft.source_observation_ids.length === 0 || !here)) ||
    (tab === "files" && draft.files.length === 0);

  const decidedAt =
    draft.status === "approved"
      ? draft.approved_at
      : draft.status === "rejected"
      ? draft.rejected_at
      : null;

  return (
    <div>
      <h3
        ref={headingRef}
        tabIndex={-1}
        data-draft-heading=""
        className="break-words text-lg font-semibold outline-none"
      >
        {draft.skill_name}
      </h3>
      {draft.description && (
        <p className="mt-1 text-sm text-muted-foreground">
          {draft.description}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {/* The project it came from, always (a phone hides the list's group
            heading); a global draft installs into every project too. */}
        <span
          className={cn(
            CHIP,
            "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]"
          )}
        >
          {projectLabel}
        </span>
        {draft.scope === "global" && (
          <span className={PLAIN_CHIP}>all projects</span>
        )}
        <span className={PLAIN_CHIP}>
          {draft.operation === "update" ? "updates a skill" : "new skill"}
        </span>
        {draft.approved_by === "auto" && (
          <span className={PLAIN_CHIP}>installed automatically</span>
        )}
      </div>

      {pending ? (
        <div className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={scopeId}>Install into</Label>
            <Select
              value={scope}
              onValueChange={(next) => {
                if (next === "workspace" || next === "global") {
                  setPick({ version, scope: next });
                }
              }}
            >
              <SelectTrigger
                id={scopeId}
                aria-describedby={installError ? errorId : undefined}
                className={cn(
                  INPUT_LIKE_TRIGGER,
                  "w-full max-md:h-11 sm:max-w-sm"
                )}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={LIST_MAX_HEIGHT}>
                <SelectItem value="workspace">
                  {projectLabel}/skills (this project)
                </SelectItem>
                <SelectItem value="global">All projects (global)</SelectItem>
              </SelectContent>
            </Select>
            {installError && (
              <p
                id={errorId}
                className="text-xs text-destructive"
              >
                {installError}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={off}
              onClick={approve}
              className="max-md:min-h-11"
            >
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={off}
              onClick={() => {
                if (!off) onReject(draft);
              }}
              className="border-solid max-md:min-h-11"
            >
              Reject
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-0.5">
          <p className="text-sm">
            {installedLabel(
              draft,
              new Map([[draft.workspace_dir, projectLabel]])
            )}
          </p>
          {decidedAt && (
            <p className="text-xs text-muted-foreground">
              {draft.status === "approved" ? "Approved" : "Rejected"} ·{" "}
              <time
                dateTime={decidedAt}
                title={formatFullTime(new Date(decidedAt))}
              >
                {formatTime(new Date(decidedAt))}
              </time>
            </p>
          )}
        </div>
      )}

      <div
        role="tablist"
        aria-label="Draft"
        className="mt-4 flex flex-wrap gap-x-1 border-b border-border"
      >
        {TABS.map((t, index) => {
          const selected = t.key === tab;
          return (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={tabId(t.key)}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t.key)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
              className={cn(
                "-mb-px border-0 border-b-2 border-solid px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11",
                selected
                  ? "border-[var(--brand)] font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(tab)}
        // A tab stop only where the panel holds nothing to focus.
        tabIndex={panelHoldsNoButtons ? 0 : undefined}
        className="mt-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {tab === "skill" && (
          <>
            <FileText text={draft.skill_md} />
            {draft.skill_md_truncated && (
              <p className="mt-2 text-xs text-muted-foreground">{TRUNCATED}</p>
            )}
          </>
        )}
        {tab === "why" &&
          (draft.rationale_md.trim() ? (
            <>
              <MarkdownContent content={draft.rationale_md} />
              {draft.rationale_md_truncated && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {TRUNCATED}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No rationale was written.
            </p>
          ))}
        {tab === "sources" && (
          <Sources
            draft={draft}
            here={here}
          />
        )}
        {tab === "files" && (
          <DraftFiles
            draft={draft}
            compareInstalled={scope === draft.scope}
          />
        )}
      </div>

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirmingVersion(null);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          // No trigger for Radix to give the focus back to: Approve opened
          // it, or the draft's heading once Approve is off, or the page's
          // fallback once this pane is gone too.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const invoker = invokerRef.current;
            invokerRef.current = null;
            focusFirst([invoker, headingRef.current, focusFallback?.()]);
          }}
        >
          <DialogHeader>
            <DialogTitle>Replace an installed skill?</DialogTitle>
            <DialogDescription>
              This replaces the installed {replaces}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmingVersion(null)}
              className="border-solid max-md:min-h-11"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={confirmReplace}
              disabled={off}
              className="max-md:min-h-11"
            >
              Replace and install
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
