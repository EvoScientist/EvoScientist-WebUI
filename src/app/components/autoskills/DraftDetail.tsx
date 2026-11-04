"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQueryState } from "nuqs";
import { DraftFiles, FileText } from "@/app/components/autoskills/DraftFiles";
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
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

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
}

/** The summaries of this machine's observations by id, read for each draft
 *  shown; null until read (or when the read failed). */
function useObservationSummaries(
  wanted: boolean,
  draftId: string
): Map<string, string> | null {
  const [summaries, setSummaries] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/memory/observations", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { nodes?: unknown };
        if (cancelled || !Array.isArray(body.nodes)) return;
        const next = new Map<string, string>();
        for (const node of body.nodes as Array<Record<string, unknown>>) {
          if (
            node &&
            typeof node.id === "string" &&
            typeof node.summary === "string" &&
            node.summary.trim()
          ) {
            next.set(node.id, node.summary);
          }
        }
        setSummaries(next);
      } catch {
        // Named by id instead.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wanted, draftId]);
  return summaries;
}

/** "Where it came from": one button per source observation, which opens
 *  it in Memory › Knowledge. */
function Sources({ draft }: { draft: Draft }) {
  const ids = draft.source_observation_ids;
  const summaries = useObservationSummaries(ids.length > 0, draft.proposal_id);
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
}: DraftDetailProps) {
  const pending = draft.status === "pending";
  const [tab, setTab] = useState<TabKey>("skill");

  // Where to install: each draft opened starts at the scope it records.
  const [pick, setPick] = useState<{ id: string; scope: DraftScope }>({
    id: draft.proposal_id,
    scope: draft.scope,
  });
  if (pick.id !== draft.proposal_id) {
    setPick({ id: draft.proposal_id, scope: draft.scope });
  }
  const scope = pick.id === draft.proposal_id ? pick.scope : draft.scope;

  // The question before an update replaces the installed skill, for this
  // draft only.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirming = pending && confirmingId === draft.proposal_id;

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
      setConfirmingId(draft.proposal_id);
    } else {
      onApprove(draft, scope);
    }
  };
  const confirmReplace = () => {
    if (off) return;
    setConfirmingId(null);
    onApprove(draft, scope);
  };

  // The recorded scope's refusal; another scope's is only known by trying.
  const installError =
    pending && scope === draft.scope && draft.install_error
      ? draft.install_error
      : null;

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
        <span
          className={cn(
            CHIP,
            "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]"
          )}
        >
          {draft.scope === "global" ? "all projects" : projectLabel}
        </span>
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
                  setPick({ id: draft.proposal_id, scope: next });
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
              {draft.status === "approved" ? "Approved" : "Rejected"}{" "}
              <time dateTime={decidedAt}>
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
        tabIndex={0}
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
        {tab === "sources" && <Sources draft={draft} />}
        {tab === "files" && <DraftFiles draft={draft} />}
      </div>

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirmingId(null);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          // No trigger for Radix to give the focus back to: Approve opened
          // it, or the draft's heading once Approve is off.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const invoker = invokerRef.current as HTMLButtonElement | null;
            invokerRef.current = null;
            const target =
              invoker?.isConnected && !invoker.disabled
                ? invoker
                : headingRef.current;
            target?.focus({ preventScroll: true });
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
              onClick={() => setConfirmingId(null)}
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
