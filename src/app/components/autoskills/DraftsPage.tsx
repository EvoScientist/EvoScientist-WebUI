"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQueryState } from "nuqs";
import { ArrowLeft, Loader2, Settings } from "lucide-react";
import { DraftList } from "@/app/components/autoskills/DraftList";
import { markAutoSeen, useAutoSkills } from "@/app/hooks/useAutoSkills";
import { useDraftActions } from "@/app/hooks/useDraftActions";
import { useRunNow } from "@/app/hooks/useRunNow";
import { useSettings, useSettingsAccess } from "@/app/hooks/useSettings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  autoSkillsReadOnlyReason,
  groupDrafts,
  statusLine,
  type Draft,
  type DraftList as Drafts,
  type DraftStatus,
} from "@/lib/autoskills";
import type { Project } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { useDeployment } from "@/providers/ClientProvider";
import { useProjects } from "@/providers/ProjectsProvider";

// Research Skills › Drafted from memory: the drafts of every registered
// project by status, grouped by project, with a multi-select to approve or
// reject several at once and the open draft beside the list.

const NO_PROJECTS: readonly Project[] = [];
const NO_SELECTION: ReadonlySet<string> = new Set();

const TABS: ReadonlyArray<{
  status: DraftStatus;
  label: string;
  param: string | null;
}> = [
  { status: "pending", label: "Pending", param: null },
  { status: "approved", label: "Approved", param: "approved" },
  { status: "rejected", label: "Rejected", param: "rejected" },
];

function statusOf(param: string | null): DraftStatus {
  return param === "approved" || param === "rejected" ? param : "pending";
}

/** "a", "a and b", "a, b and c". */
function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The ids of `selected` that are still pending in `list`. */
function stillPending(
  selected: ReadonlySet<string>,
  list: Drafts
): ReadonlySet<string> {
  const pending = new Set(
    list.drafts.filter((d) => d.status === "pending").map((d) => d.proposal_id)
  );
  const kept = [...selected].filter((id) => pending.has(id));
  return kept.length === selected.size ? selected : new Set(kept);
}

export function DraftsPage() {
  const [, setSkillsPage] = useQueryState("skillsPage");
  const [tabParam, setTabParam] = useQueryState("draftsTab");
  const [draftId, setDraftId] = useQueryState("draftId");
  const status = statusOf(tabParam);

  const auto = useAutoSkills();
  const { projects } = useProjects();
  const projectList =
    projects.status === "ready" ? projects.projects : NO_PROJECTS;
  const { payload } = useSettings();
  const { access } = useSettingsAccess();
  const { approve, reject, busy } = useDraftActions(projectList);
  const { running, run } = useRunNow(projectList);
  const { deploymentUrl } = useDeployment();

  // The panel itself comes with the AutoSkills settings.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_SELECTION);

  const list = auto.status === "ready" ? auto.list : null;

  // A new list keeps only the picks still pending in it (a draft decided in
  // the CLI or another tab drops out, and so do the ones just decided here
  // once the list is read again); another tab starts with none.
  const [basis, setBasis] = useState({ list, status });
  if (basis.list !== list || basis.status !== status) {
    setBasis({ list, status });
    if (basis.status !== status) setSelected(NO_SELECTION);
    else if (list) setSelected((prev) => stillPending(prev, list));
  }

  // Opening this page counts as having seen the automatic installs.
  const markedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!deploymentUrl || markedFor.current === deploymentUrl) return;
    markedFor.current = deploymentUrl;
    markAutoSeen(deploymentUrl, new Date().toISOString());
  }, [deploymentUrl]);

  const groups = useMemo(
    () => (list ? groupDrafts(list, projectList, status) : []),
    [list, projectList, status]
  );
  const shown = useMemo(() => groups.flatMap((g) => g.drafts), [groups]);
  const openDraft = shown.find((d) => d.proposal_id === draftId) ?? null;
  const selectedDrafts = shown.filter((d) => selected.has(d.proposal_id));
  const updates = selectedDrafts
    .filter((d) => d.operation === "update")
    .map((d) => d.target_skill_name ?? d.skill_name);

  // The question only stands while the selection still holds an update.
  if (confirming && updates.length === 0) setConfirming(false);

  const canWrite = access?.writable === true;
  const readOnlyReason = autoSkillsReadOnlyReason(access);
  const line = statusLine(payload?.settings);

  const baseId = useId();
  const tabId = (s: DraftStatus) => `${baseId}-tab-${s}`;
  const panelId = `${baseId}-panel`;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const showTab = (index: number) => void setTabParam(TABS[index].param);
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
    showTab(to);
    tabRefs.current[to]?.focus();
  };

  const backToSkills = () => {
    void setSkillsPage(null);
    void setTabParam(null);
    void setDraftId(null);
  };

  const toggle = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  // No scopes: in bulk every draft installs where it records (its own
  // project, or global); only the detail pane picks a scope per draft.
  const approveSelection = () => {
    if (updates.length > 0) setConfirming(true);
    else void approve(selectedDrafts);
  };
  const confirmReplace = () => {
    setConfirming(false);
    void approve(selectedDrafts);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1100px] px-4 py-5 sm:px-5 sm:py-6">
        <nav aria-label="Breadcrumb">
          <ol className="m-0 flex list-none flex-wrap items-center gap-x-1.5 p-0 text-xl font-semibold sm:text-2xl">
            <li className="mb-0">
              <button
                type="button"
                onClick={backToSkills}
                className="rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
              >
                Research Skills
              </button>
            </li>
            <li className="mb-0 flex items-center gap-x-1.5">
              <span
                aria-hidden="true"
                className="text-muted-foreground"
              >
                ›
              </span>
              <h2
                aria-current="page"
                className="text-xl font-semibold sm:text-2xl"
              >
                Drafted from memory
              </h2>
            </li>
          </ol>
        </nav>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          {line && (
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">
              {line}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(true)}
            className="ml-auto border-solid max-md:min-h-11"
          >
            <Settings aria-hidden="true" />
            Settings
          </Button>
        </div>

        {auto.status === "unsupported" ? (
          <p className="mt-6 text-sm">
            Update EvoScientist to review drafts here.
          </p>
        ) : auto.status === "error" ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <p
              role="alert"
              className="text-sm text-destructive"
            >
              Couldn&apos;t read the drafts.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void auto.refresh()}
              className="border-solid max-md:min-h-11"
            >
              Retry
            </Button>
          </div>
        ) : auto.status === "loading" || !list ? (
          <div
            className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"
            aria-live="polite"
          >
            <Loader2
              className="size-4 animate-spin"
              aria-hidden="true"
            />
            Loading drafts…
          </div>
        ) : (
          <>
            {readOnlyReason && (
              <p className="mt-4 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                {readOnlyReason}
              </p>
            )}

            <div
              role="tablist"
              aria-label="Drafts"
              className="mt-4 flex gap-1 border-b border-border"
            >
              {TABS.map((tab, index) => {
                const selectedTab = tab.status === status;
                return (
                  <button
                    key={tab.status}
                    ref={(el) => {
                      tabRefs.current[index] = el;
                    }}
                    type="button"
                    role="tab"
                    id={tabId(tab.status)}
                    aria-selected={selectedTab}
                    aria-controls={panelId}
                    tabIndex={selectedTab ? 0 : -1}
                    onClick={() => showTab(index)}
                    onKeyDown={(e) => onTabKeyDown(e, index)}
                    className={cn(
                      "-mb-px border-0 border-b-2 border-solid px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11",
                      selectedTab
                        ? "border-[var(--brand)] font-medium text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {tab.label}{" "}
                    <span className="tabular-nums">
                      {list.counts[tab.status]}
                    </span>
                  </button>
                );
              })}
            </div>

            <div
              role="tabpanel"
              id={panelId}
              aria-labelledby={tabId(status)}
              className={cn(
                "mt-4",
                shown.length > 0 &&
                  "md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-start md:gap-4"
              )}
            >
              <div className={cn("min-w-0", openDraft && "max-md:hidden")}>
                {selectedDrafts.length > 0 && (
                  <div
                    role="region"
                    aria-label="Selection"
                    className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2"
                  >
                    <span className="mr-auto text-sm font-medium">
                      {selectedDrafts.length} selected
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!canWrite || busy}
                      onClick={approveSelection}
                      className="max-md:min-h-11"
                    >
                      Approve
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!canWrite || busy}
                      onClick={() => void reject(selectedDrafts)}
                      className="border-solid max-md:min-h-11"
                    >
                      Reject
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelected(NO_SELECTION)}
                      className="max-md:min-h-11"
                    >
                      Clear
                    </Button>
                  </div>
                )}
                <DraftList
                  groups={groups}
                  status={status}
                  selected={selected}
                  onToggle={toggle}
                  openId={openDraft?.proposal_id ?? null}
                  onOpen={(id) => void setDraftId(id)}
                  running={running}
                  onRun={(key) => void run(key)}
                  canWrite={canWrite}
                />
              </div>

              {/* An empty tab says so on its own: nothing to select. */}
              {shown.length > 0 && (
                <div
                  className={cn(
                    "min-w-0 rounded-lg border border-border bg-card p-4 md:sticky md:top-0",
                    !openDraft && "max-md:hidden"
                  )}
                >
                  {openDraft ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void setDraftId(null)}
                        className="-ml-2 mb-2 min-h-11 md:hidden"
                      >
                        <ArrowLeft aria-hidden="true" />
                        Back to drafts
                      </Button>
                      <OpenDraft draft={openDraft} />
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Select a draft to read it.
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <Dialog
        open={confirming && updates.length > 0}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {updates.length === 1
                ? "Replace an installed skill?"
                : "Replace installed skills?"}
            </DialogTitle>
            <DialogDescription>
              This replaces the installed {joinNames(updates)}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(false)}
              className="border-solid"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={confirmReplace}
              disabled={!canWrite || busy}
            >
              Replace and install
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The open draft. Its full detail (the draft's files and the decision)
 *  is drawn here. */
function OpenDraft({ draft }: { draft: Draft }) {
  return (
    <div>
      <h3 className="break-words text-lg font-semibold">{draft.skill_name}</h3>
      {draft.description && (
        <p className="mt-1 text-sm text-muted-foreground">
          {draft.description}
        </p>
      )}
    </div>
  );
}
