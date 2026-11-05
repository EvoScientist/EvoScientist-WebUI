"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQueryState } from "nuqs";
import { ArrowLeft, Loader2, Settings } from "lucide-react";
import { AutoSkillsSettings } from "@/app/components/autoskills/AutoSkillsSettings";
import { DraftDetail } from "@/app/components/autoskills/DraftDetail";
import { DraftList } from "@/app/components/autoskills/DraftList";
import {
  focusFirst,
  useFocusFallback,
} from "@/app/components/autoskills/focus";
import { decidable, stillPending } from "@/app/components/autoskills/selection";
import { markAutoSeen, useAutoSkills } from "@/app/hooks/useAutoSkills";
import { useDraftActions } from "@/app/hooks/useDraftActions";
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
  labelFor,
  statusLine,
  type Draft,
  type DraftScope,
  type DraftStatus,
} from "@/lib/autoskills";
import type { Project } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { useDeployment } from "@/providers/ClientProvider";
import { useProjects } from "@/providers/ProjectsProvider";
import { useRunNowState } from "@/providers/runNowContext";

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

/** The skills an approval replaces, by name; a name that repeats (the same
 *  skill in two projects) carries its project. */
function replacedNames(
  updates: readonly Draft[],
  labels: Map<string, string>
): string[] {
  const names = updates.map((d) => d.target_skill_name ?? d.skill_name);
  const seen = new Map<string, number>();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  return names.map((n, i) =>
    (seen.get(n) ?? 0) > 1
      ? `${n} (${labelFor(updates[i].workspace_dir, labels)})`
      : n
  );
}

/** Below 768 px, where the open draft takes the list's place (max-md:). */
function isPhone(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(min-width: 768px)").matches
  );
}

export function DraftsPage() {
  const [, setSkillsPage] = useQueryState("skillsPage");
  const [tabParam, setTabParam] = useQueryState("draftsTab");
  const [draftId, setDraftId] = useQueryState("draftId");
  const status = statusOf(tabParam);

  const auto = useAutoSkills();
  const { projects, refreshing, isReady } = useProjects();
  const projectList =
    projects.status === "ready" ? projects.projects : NO_PROJECTS;
  // The registered projects' keys, or null while they aren't known: not
  // read yet, or being read again (the last list stays "ready" meanwhile,
  // and nothing runs). Every decision and Run now waits for it.
  const registered = useMemo(
    () =>
      projects.status === "ready" && !refreshing
        ? new Set(projects.projects.map((p) => p.key))
        : null,
    [projects, refreshing]
  );
  const { payload } = useSettings();
  const { access } = useSettingsAccess();
  const { approve, reject, busy } = useDraftActions(projectList);
  // Kept above the views: a run goes on, and is reported, after this page
  // is left.
  const { run } = useRunNowState();
  const { deploymentUrl } = useDeployment();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_SELECTION);

  const list = auto.status === "ready" ? auto.list : null;

  // A new list keeps only the picks still pending in it (a draft decided in
  // the CLI or another tab drops out, and so do the ones just decided here
  // once the list is read again), and new projects only the picks of a
  // project still registered (a bulk decision never sends a stale id);
  // another tab starts with none.
  const [basis, setBasis] = useState({ list, status, registered });
  if (
    basis.list !== list ||
    basis.status !== status ||
    basis.registered !== registered
  ) {
    setBasis({ list, status, registered });
    if (basis.status !== status) setSelected(NO_SELECTION);
    else if (list) {
      setSelected((prev) => stillPending(prev, list, registered));
    }
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
  const labels = useMemo(
    () => new Map(groups.map((g) => [g.project.key, g.label])),
    [groups]
  );
  const updates = replacedNames(
    selectedDrafts.filter((d) => d.operation === "update"),
    labels
  );

  // The question only stands while the selection still holds an update.
  if (confirming && updates.length === 0) setConfirming(false);

  const canWrite = access?.writable === true;
  // A decision also waits for the projects: until they are known (read
  // again) the selection can't be checked against them.
  const canDecide = canWrite && registered !== null;
  // Said only once known: while access is being checked every decision
  // waits, without a box that goes again a moment later.
  const readOnlyReason =
    access && !access.writable ? autoSkillsReadOnlyReason(access) : null;
  const line = statusLine(payload?.settings);

  const baseId = useId();
  const tabId = (s: DraftStatus) => `${baseId}-tab-${s}`;
  const panelId = `${baseId}-panel`;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedTab = () =>
    tabRefs.current[TABS.findIndex((t) => t.status === status)];

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

  // Focus. Below 768 px opening a draft hides the list (and the row that
  // had the focus), and Back hides itself: the focus follows to the pane's
  // Back button, and back to the row (or the selected tab).
  const listRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const focusRequest = useRef<{ to: "pane" | "row"; id: string } | null>(null);
  const openRow = (id: string) => {
    focusRequest.current = isPhone() ? { to: "pane", id } : null;
    void setDraftId(id);
  };
  const closeDraft = () => {
    focusRequest.current =
      openDraft && isPhone() ? { to: "row", id: openDraft.proposal_id } : null;
    void setDraftId(null);
  };
  useEffect(() => {
    const want = focusRequest.current;
    if (!want) return;
    if (want.to === "pane") {
      if (draftId !== want.id) return;
      focusRequest.current = null;
      focusFirst([backRef.current]);
    } else {
      if (draftId !== null) return;
      focusRequest.current = null;
      const row = [
        ...(listRef.current?.querySelectorAll<HTMLElement>("[data-draft-id]") ??
          []),
      ].find((el) => el.dataset.draftId === want.id);
      focusFirst([row, selectedTab()]);
    }
  });

  // The selection bar: when its buttons go (the re-read emptied the
  // selection, Clear) or turn off (a decision under way) while the focus was
  // in it, the focus moves to the selected tab instead of the page.
  const approveRef = useRef<HTMLButtonElement>(null);
  const bar = useFocusFallback(
    selectedDrafts.length === 0
      ? "gone"
      : !canDecide || busy
      ? "disabled"
      : "usable",
    () => [selectedTab()]
  );

  // The open draft: decided alone, with the scope its pane picked (the only
  // decision that sends one), through the same gate as the bar. Its buttons
  // are off for a draft the core would refuse (its project not served).
  const openDecidable =
    !!openDraft && decidable([openDraft], list, registered).length > 0;
  const canDecideOpen = canDecide && openDecidable;
  const approveOpen = (d: Draft, scope: DraftScope) => {
    if (!isReady()) return;
    const [send] = decidable([d], list, registered);
    if (send) void approve([send], { [send.proposal_id]: scope });
  };
  const rejectOpen = (d: Draft) => {
    if (!isReady()) return;
    const [send] = decidable([d], list, registered);
    if (send) void reject([send]);
  };
  // When its buttons turn off under the focus it stays in the pane, on the
  // draft's heading; when the draft leaves the list, on the selected tab.
  const pane = useFocusFallback(
    !openDraft
      ? "gone"
      : openDraft.status === "pending" && (!canDecideOpen || busy)
      ? "disabled"
      : "usable",
    (box) => [
      box?.querySelector<HTMLElement>("[data-draft-heading]"),
      selectedTab(),
    ]
  );

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
  // What is sent is checked once more against the list and the projects
  // (the selection is pruned by the same rule on every change), and only
  // while the projects' gate is open: a read that has just started closes
  // it before the render that disables the buttons.
  const approveSelection = () => {
    if (!isReady()) return;
    const send = decidable(selectedDrafts, list, registered);
    if (send.length === 0) return;
    if (send.some((d) => d.operation === "update")) setConfirming(true);
    else void approve(send);
  };
  // A closed gate leaves the question open, to be answered after the read.
  const confirmReplace = () => {
    if (!isReady()) return;
    setConfirming(false);
    const send = decidable(selectedDrafts, list, registered);
    if (send.length > 0) void approve(send);
  };
  const rejectSelection = () => {
    if (!isReady()) return;
    const send = decidable(selectedDrafts, list, registered);
    if (send.length > 0) void reject(send);
  };
  const runNow = (key: string) => {
    if (isReady()) void run(key);
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
            ref={settingsButtonRef}
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(true)}
            className="ml-auto border-solid max-md:min-h-11"
          >
            <Settings aria-hidden="true" />
            Settings
          </Button>
        </div>
        <AutoSkillsSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          returnFocusTo={settingsButtonRef}
        />

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
              <div
                ref={listRef}
                className={cn("min-w-0", openDraft && "max-md:hidden")}
              >
                {selectedDrafts.length > 0 && (
                  <div
                    {...bar}
                    role="region"
                    aria-label="Selection"
                    className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2"
                  >
                    <span className="mr-auto text-sm font-medium">
                      {selectedDrafts.length} selected
                    </span>
                    <Button
                      ref={approveRef}
                      type="button"
                      size="sm"
                      disabled={!canDecide || busy}
                      onClick={approveSelection}
                      className="max-md:min-h-11"
                    >
                      Approve
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!canDecide || busy}
                      onClick={rejectSelection}
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
                  onOpen={openRow}
                  onRun={runNow}
                  canWrite={canWrite}
                  registered={registered}
                />
              </div>

              {/* An empty tab says so on its own: nothing to select. */}
              {shown.length > 0 && (
                <div
                  {...pane}
                  className={cn(
                    // Its own scrolling, within the viewport: a long draft
                    // stays reachable while the list scrolls beside it.
                    "scrollbar-pretty min-w-0 rounded-lg border border-border bg-card p-4 md:sticky md:top-4 md:max-h-[calc(100dvh-6rem)] md:overflow-y-auto",
                    !openDraft && "max-md:hidden"
                  )}
                >
                  {openDraft ? (
                    <>
                      <Button
                        ref={backRef}
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={closeDraft}
                        className="-ml-2 mb-2 min-h-11 md:hidden"
                      >
                        <ArrowLeft aria-hidden="true" />
                        Back to drafts
                      </Button>
                      <DraftDetail
                        draft={openDraft}
                        projectLabel={labelFor(openDraft.workspace_dir, labels)}
                        canWrite={canDecideOpen}
                        busy={busy}
                        onApprove={approveOpen}
                        onReject={rejectOpen}
                        focusFallback={selectedTab}
                      />
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
        <DialogContent
          className="sm:max-w-md"
          // No trigger for Radix to give the focus back to: Approve opened
          // it, or the selected tab once Approve is gone or off.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusFirst([approveRef.current, selectedTab()]);
          }}
        >
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
              className="border-solid max-md:min-h-11"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={confirmReplace}
              disabled={!canDecide || busy}
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
