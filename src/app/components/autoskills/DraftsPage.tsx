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
import {
  fileSection,
  filesQuestion,
  useShownQuestion,
  withFiles,
  type Question,
} from "@/app/components/autoskills/question";
import { QuestionDescription } from "@/app/components/autoskills/QuestionDescription";
import {
  asSelected,
  decidable,
  stillListed,
  stillPending,
} from "@/app/components/autoskills/selection";
import {
  markAutoSeen,
  useAutoSkills,
  useDraftFilesCheck,
  type UnshowableByDraft,
} from "@/app/hooks/useAutoSkills";
import {
  useDraftActions,
  type DecisionResult,
} from "@/app/hooks/useDraftActions";
import { useSettings, useSettingsAccess } from "@/app/hooks/useSettings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  autoSkillsReadOnlyReason,
  groupDrafts,
  isProjectCopy,
  labelFor,
  statusLine,
  type Draft,
  type DraftScope,
  type DraftStatus,
  type UnshowableFile,
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
/** No holds: each held id maps to the token of the decision or Undo that
 *  holds it. */
const NO_HOLDS: ReadonlyMap<string, number> = new Map();
const NO_TOKENS: readonly number[] = [];
/** No picks: a selection maps each picked id to the draft's updated_at as
 *  listed when it was picked. */
const NO_SELECTION: ReadonlyMap<string, string> = new Map();
/** A bulk approval as clicked: its drafts, each at the version it was
 *  picked at, and the files their check found the page can't show. */
interface BulkDecision {
  drafts: readonly Draft[];
  found: UnshowableByDraft;
}
/** No bulk approval asked about yet. */
const NO_DECISION: BulkDecision = { drafts: [], found: new Map() };

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

/** `selection` without the picks of `ids`; the same one when none is in
 *  it. */
function unpick(
  selection: ReadonlyMap<string, string>,
  ids: readonly string[]
): ReadonlyMap<string, string> {
  if (!ids.some((id) => selection.has(id))) return selection;
  const next = new Map(selection);
  for (const id of ids) next.delete(id);
  return next;
}

/** `holds` with each of `ids` held under `token`. */
function hold(
  holds: ReadonlyMap<string, number>,
  ids: readonly string[],
  token: number
): ReadonlyMap<string, number> {
  const next = new Map(holds);
  for (const id of ids) next.set(id, token);
  return next;
}

/** `holds` without the ones made under `tokens`; the same map when none
 *  is. */
function release(
  holds: ReadonlyMap<string, number>,
  tokens: readonly number[]
): ReadonlyMap<string, number> {
  const gone = [...holds].filter(([, token]) => tokens.includes(token));
  if (gone.length === 0) return holds;
  const next = new Map(holds);
  for (const [id] of gone) next.delete(id);
  return next;
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

/** The drafts' own names; a name that repeats (the same skill drafted in
 *  two projects) carries its project. */
function draftNames(
  drafts: readonly Draft[],
  labels: Map<string, string>
): string[] {
  const seen = new Map<string, number>();
  for (const d of drafts) {
    seen.set(d.skill_name, (seen.get(d.skill_name) ?? 0) + 1);
  }
  return drafts.map((d) =>
    (seen.get(d.skill_name) ?? 0) > 1
      ? `${d.skill_name} (${labelFor(d.workspace_dir, labels)})`
      : d.skill_name
  );
}

/** The question before a bulk approval of `drafts`: the updates' question
 *  when it holds any, with the files the page can't show (`found`) under
 *  it; else the question about those files alone. */
function bulkQuestion(
  drafts: readonly Draft[],
  found: UnshowableByDraft,
  labels: Map<string, string>
): Question {
  const holders = drafts.filter((d) => found.has(d.proposal_id));
  const names = draftNames(holders, labels);
  const section = fileSection(
    holders.map((d, i) => ({
      name: names[i],
      files: found.get(d.proposal_id) ?? [],
    }))
  );
  const updates = drafts.filter((d) => d.operation === "update");
  return updates.length > 0
    ? withFiles(updatesQuestion(updates, labels), section)
    : filesQuestion(section);
}

/** The question before a bulk approval that holds updates: what each
 *  replaces, and which projects get their own copy of a global skill (the
 *  global one stays). Every approval goes where its draft records. */
function updatesQuestion(
  updates: readonly Draft[],
  labels: Map<string, string>
): Question {
  const names = replacedNames(updates, labels);
  const replaces: string[] = [];
  const copies: Array<{ draft: Draft; name: string }> = [];
  updates.forEach((draft, i) => {
    if (isProjectCopy(draft)) copies.push({ draft, name: names[i] });
    else replaces.push(names[i]);
  });

  let title: string;
  if (copies.length === 0) {
    title =
      replaces.length === 1
        ? "Replace an installed skill?"
        : "Replace installed skills?";
  } else if (replaces.length === 0) {
    title =
      copies.length === 1
        ? "Install a project copy?"
        : "Install project copies?";
  } else {
    title = "Install updated skills?";
  }

  const sentences: string[] = [];
  if (replaces.length > 0) {
    sentences.push(`This replaces the installed ${joinNames(replaces)}.`);
  }
  if (copies.length === 1) {
    const { draft } = copies[0];
    const name = draft.target_skill_name ?? draft.skill_name;
    const project = labelFor(draft.workspace_dir, labels);
    sentences.push(
      `${project} gets its own ${name} with these changes; the global ${name} stays as it is.`
    );
  } else if (copies.length > 1) {
    const copied = joinNames(copies.map((c) => c.name));
    sentences.push(
      `${copied} get their own copies in their projects; the global skills stay as they are.`
    );
  }

  return {
    title,
    description: sentences.join(" "),
    action: replaces.length > 0 ? "Replace and install" : "Install",
  };
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
  // Drafts decided (or taken back) here that wait for the next list: the
  // core has decided them, but the re-read hasn't landed (or stalls). They
  // leave the selection at once and can't be decided again until the next
  // list arrives. An Undo that succeeds holds its drafts the same way: the
  // revert gave them a new updated_at, which only a read after it carries.
  // Each hold has the token of the decision or Undo that made it.
  const [decided, setDecided] = useState<ReadonlyMap<string, number>>(NO_HOLDS);
  const holdSeq = useRef(0);
  // Undos whose own re-read has settled, by token, for the next render.
  const [readUndos, setReadUndos] = useState<readonly number[]>(NO_TOKENS);
  const { approve, reject, busy } = useDraftActions(projectList, {
    onReverted: (drafts, reread) => {
      const token = ++holdSeq.current;
      const ids = drafts.map((d) => d.proposal_id);
      setDecided((prev) => hold(prev, ids, token));
      // Settled either way: the release below waits for the newest read.
      const settled = () => setReadUndos((prev) => [...prev, token]);
      void reread.then(settled, settled);
    },
  });
  // Kept above the views: a run goes on, and is reported, after this page
  // is left.
  const { run } = useRunNowState();
  const { deploymentUrl } = useDeployment();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] =
    useState<ReadonlyMap<string, string>>(NO_SELECTION);
  // An approval checks the files of its drafts first. While a check reads,
  // its Approve (the bar's, or the pane's for the draft checked) says so
  // and no decision starts.
  const checkFiles = useDraftFilesCheck();
  const [checking, setChecking] = useState<
    { from: "bulk" } | { from: "pane"; id: string } | null
  >(null);
  const checkSeq = useRef(0);
  useEffect(
    () => () => {
      // Gone: a check's answer is dropped.
      checkSeq.current += 1;
    },
    []
  );
  // The bulk approval the question asks about: only these drafts go, at
  // the versions recorded at the click, whatever is picked meanwhile.
  const [asked, setAsked] = useState<BulkDecision>(NO_DECISION);

  const list = auto.status === "ready" ? auto.list : null;
  // Read on every render, so the page renders again when a read of the list
  // ends (the Undo holds below wait for that).
  const reading = auto.isValidating;

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
    // The first list after a decision or an Undo takes over, whatever it
    // says: decided there, they aren't pending; pending again (an Undo here
    // or in another window), they are decidable again, at the updated_at it
    // lists. Every id here was recorded before it.
    if (list && basis.list !== list) {
      setDecided((prev) => (prev.size === 0 ? prev : NO_HOLDS));
    }
  }
  // An Undo's own re-read has settled, but a newer read may have replaced
  // it: SWR discards the replaced read without writing the list, and its
  // promise still settles. So the holds that Undo made go in the first
  // render with the list ready and no read in flight: that list comes from
  // the newest read, which started after the revert, even if SWR kept the
  // cached object (equal data) and no new list comes. A newer hold of the
  // same draft stays. While reads fail nothing changes: the next list
  // releases every hold.
  if (readUndos.length > 0 && auto.status === "ready" && !reading) {
    setReadUndos(NO_TOKENS);
    setDecided((prev) => release(prev, readUndos));
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
  const selectedIds = useMemo(() => new Set(selected.keys()), [selected]);
  const decidedIds = useMemo(() => new Set(decided.keys()), [decided]);
  const labels = useMemo(
    () => new Map(groups.map((g) => [g.project.key, g.label])),
    [groups]
  );
  // What a decision may send: still pending in the list, in a registered
  // project, and not held here: decided here already, or moved back by an
  // Undo here, while the list doesn't show that yet.
  const sendable = (drafts: readonly Draft[]) =>
    decidable(drafts, list, registered).filter(
      (d) => !decided.has(d.proposal_id)
    );
  // What the bulk question asks about: the drafts of its approval still
  // pending and not held here (one decided elsewhere or gone meanwhile is
  // left out; while the projects are read again it waits, as the selection
  // does).
  const askedDrafts = stillListed(asked.drafts, list, registered).filter(
    (d) => !decided.has(d.proposal_id)
  );

  // The question only stands while those drafts still hold an update or a
  // file the page can't show.
  const askable = askedDrafts.some(
    (d) => d.operation === "update" || asked.found.has(d.proposal_id)
  );
  if (confirming && !askable) setConfirming(false);
  const asking = confirming && askable;
  // While it fades out the question keeps the words it had open: a
  // decision's answers prune the selection meanwhile.
  const question = useShownQuestion(
    asking,
    bulkQuestion(askedDrafts, asked.found, labels)
  );

  // A decision under way, or the check before one.
  const working = busy || checking !== null;
  const canWrite = access?.writable === true;
  // A decision also waits for the projects: until they are known (read
  // again) the selection can't be checked against them.
  const canDecide = canWrite && registered !== null;
  // Said only once known: while access is being checked every decision
  // waits, without a box that goes again a moment later.
  const readOnlyReason =
    access && !access.writable ? autoSkillsReadOnlyReason(access) : null;
  const line = statusLine(payload?.settings);
  // Only settings that say so: unknown ones leave Run now to the core.
  const autoSkillsOff =
    payload?.settings?.memory_skill_synthesis_enabled === false;

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
      : !canDecide || working
      ? "disabled"
      : "usable",
    () => [selectedTab()]
  );

  // A decision's answers are in: what went through leaves the selection
  // and waits for the list. A draft that changed since the page read it
  // (nothing installed) leaves the selection too, so a second click can't
  // approve its new version unread, but stays decidable: it is pending.
  const settle = ({ done, failed }: DecisionResult) => {
    const ids = done.map((d) => d.proposal_id);
    const changed = failed
      .filter((f) => f.changed)
      .map((f) => f.draft.proposal_id);
    if (ids.length === 0 && changed.length === 0) return;
    setSelected((prev) => unpick(prev, [...ids, ...changed]));
    if (ids.length > 0) {
      const token = ++holdSeq.current;
      setDecided((prev) => hold(prev, ids, token));
    }
  };

  // The open draft: decided alone, with the scope its pane picked (the only
  // decision that sends one), through the same gate as the bar. Its buttons
  // are off for a draft the core would refuse (its project not served) or
  // that was just decided here.
  const openDecidable = !!openDraft && sendable([openDraft]).length > 0;
  const canDecideOpen = canDecide && openDecidable;
  const approveOpen = (d: Draft, scope: DraftScope) => {
    if (!isReady()) return;
    const [send] = sendable([d]);
    if (send) void approve([send], { [send.proposal_id]: scope }).then(settle);
  };
  const rejectOpen = (d: Draft) => {
    if (!isReady()) return;
    const [send] = sendable([d]);
    if (send) void reject([send]).then(settle);
  };
  // When its buttons turn off under the focus it stays in the pane, on the
  // draft's heading; when the draft leaves the list, on the selected tab.
  const pane = useFocusFallback(
    !openDraft
      ? "gone"
      : openDraft.status === "pending" && (!canDecideOpen || working)
      ? "disabled"
      : "usable",
    (box) => [
      box?.querySelector<HTMLElement>("[data-draft-heading]"),
      selectedTab(),
    ]
  );

  // A pick records the draft's updated_at as listed now: a bulk approve
  // sends that version, so a draft rewritten since draws draft_changed
  // instead of installing unread. One picked already keeps its own.
  const toggle = (ids: string[], on: boolean) => {
    const listed = new Map(shown.map((d) => [d.proposal_id, d.updated_at]));
    setSelected((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        const stamp = listed.get(id);
        if (!on) next.delete(id);
        else if (!next.has(id) && stamp !== undefined) next.set(id, stamp);
      }
      return next;
    });
  };

  /** The files of `drafts` the page can't show: at once when nothing has
   *  to be read; else once read, with `from`'s Approve saying so and the
   *  page busy meanwhile (null when the page went). */
  const checkFor = (
    drafts: readonly Draft[],
    from: NonNullable<typeof checking>
  ): UnshowableByDraft | Promise<UnshowableByDraft | null> => {
    const out = checkFiles(drafts);
    if (!(out instanceof Promise)) return out;
    const token = ++checkSeq.current;
    setChecking(from);
    const done = () => {
      if (token !== checkSeq.current) return false;
      setChecking(null);
      return true;
    };
    // A check never rejects; if one did, the page would stay busy.
    return out.then(
      (found) => (done() ? found : null),
      () => {
        done();
        return null;
      }
    );
  };
  // A check that reads answers later: it goes on with the page as it is
  // then (the latest render).
  const afterBulkCheck = useRef<(decision: BulkDecision) => void>(() => {});
  // The approval as clicked goes, without the drafts that can't be decided
  // any more; one picked during the check waits for the next Approve. With
  // an update or a file the page can't show among them, the question first.
  afterBulkCheck.current = (decision) => {
    const send = sendable(decision.drafts);
    if (send.length === 0) return;
    if (
      send.some(
        (d) => d.operation === "update" || decision.found.has(d.proposal_id)
      )
    ) {
      setAsked(decision);
      setConfirming(true);
    } else if (canDecide && isReady()) {
      void approve(send).then(settle);
    }
  };

  // No scopes: in bulk every draft installs where it records (its own
  // project, or global); only the detail pane picks a scope per draft.
  // The decision is fixed at the click: the drafts picked then, each at the
  // version it was picked at (`asSelected`), whatever is picked while their
  // files are checked. What is sent is checked once more against the list
  // and the projects (the selection is pruned by the same rule on every
  // change), and only while the projects' gate is open: a read that has
  // just started closes it before the render that disables the buttons.
  // The drafts' files are checked first (as listed now: their current
  // files).
  const approveSelection = () => {
    if (!isReady()) return;
    const send = sendable(selectedDrafts);
    if (send.length === 0) return;
    const drafts = asSelected(send, selected);
    const out = checkFor(send, { from: "bulk" });
    if (!(out instanceof Promise)) {
      afterBulkCheck.current({ drafts, found: out });
      return;
    }
    void out.then((found) => {
      if (found) afterBulkCheck.current({ drafts, found });
    });
  };
  // A closed gate leaves the question open, to be answered after the read.
  // The question still takes clicks while it fades out: after Cancel,
  // Escape or a first click, it sends nothing.
  const confirmApproval = () => {
    if (!asking || !isReady()) return;
    setConfirming(false);
    const send = sendable(asked.drafts);
    if (send.length > 0) void approve(send).then(settle);
  };
  // The open draft's check, for its pane: the files of that draft.
  const checkOpen = (
    d: Draft
  ): UnshowableFile[] | Promise<UnshowableFile[] | null> => {
    const out = checkFor([d], { from: "pane", id: d.proposal_id });
    if (!(out instanceof Promise)) return out.get(d.proposal_id) ?? [];
    return out.then((found) => (found ? found.get(d.proposal_id) ?? [] : null));
  };
  const rejectSelection = () => {
    if (!isReady()) return;
    const send = sendable(selectedDrafts);
    if (send.length > 0) void reject(send).then(settle);
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
                      disabled={!canDecide || working}
                      onClick={approveSelection}
                      className="max-md:min-h-11"
                    >
                      {checking?.from === "bulk"
                        ? "Checking files…"
                        : "Approve"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!canDecide || working}
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
                  selected={selectedIds}
                  onToggle={toggle}
                  openId={openDraft?.proposal_id ?? null}
                  onOpen={openRow}
                  onRun={runNow}
                  canWrite={canWrite}
                  registered={registered}
                  autoSkillsOff={autoSkillsOff}
                  decided={decidedIds}
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
                        busy={working}
                        checking={
                          checking?.from === "pane" &&
                          checking.id === openDraft.proposal_id
                        }
                        checkFiles={checkOpen}
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
        open={asking}
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
            <DialogTitle>{question.title}</DialogTitle>
            <QuestionDescription question={question} />
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
              onClick={confirmApproval}
              disabled={!canDecide || working}
              className="max-md:min-h-11"
            >
              {question.action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
