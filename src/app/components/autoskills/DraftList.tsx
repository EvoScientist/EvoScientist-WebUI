"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  installedLabel,
  type Draft,
  type DraftGroup,
  type DraftStatus,
} from "@/lib/autoskills";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useRunNowState } from "@/providers/runNowContext";

// The drafts of one tab, one collapsible group per project. Selection and
// the open draft live in the page, the runs above the views (they go on
// after the page is left); this only draws them.

const CHECKBOX =
  "size-4 rounded border border-muted-foreground bg-transparent text-[var(--brand-solid)] focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50";
// The checkbox's own box stays 16px; on a phone the label around it is the
// 44px touch target.
const CHECKBOX_TARGET =
  "flex shrink-0 items-center justify-center p-1 max-md:min-h-11 max-md:min-w-11";

export interface DraftListProps {
  groups: DraftGroup[];
  status: DraftStatus;
  selected: ReadonlySet<string>;
  onToggle(ids: string[], on: boolean): void;
  openId: string | null;
  onOpen(id: string): void;
  onRun(projectKey: string): void;
  canWrite: boolean;
  /** The registered projects' keys; null while they are not known. Until
   *  they are, nothing runs and nothing is picked; then a group of a project
   *  the backend doesn't serve (any more) neither: the core would refuse. */
  registered: ReadonlySet<string> | null;
  /** The settings say AutoSkills is off: Run now waits (unknown settings
   *  don't count; the core says so then). */
  autoSkillsOff: boolean;
}

const RUN_OFF = "AutoSkills is off. Turn it on in Settings first.";

export function DraftList({
  groups,
  status,
  selected,
  onToggle,
  openId,
  onOpen,
  onRun,
  canWrite,
  registered,
  autoSkillsOff,
}: DraftListProps) {
  const { running } = useRunNowState();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // The groups already carry the page's labels: installedLabel reads them.
  const labels = useMemo(
    () => new Map(groups.map((g) => [g.project.key, g.label])),
    [groups]
  );
  const pending = status === "pending";
  const empty = groups.every((g) => g.drafts.length === 0);

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!pending && empty) {
    return (
      <p className="py-6 text-sm text-muted-foreground">Nothing here yet.</p>
    );
  }

  return (
    <div className="space-y-3">
      {pending && empty && (
        <p className="text-sm text-muted-foreground">
          All caught up — nothing waits for review.
        </p>
      )}
      {groups.map((group) => (
        <Group
          key={group.project.key}
          group={group}
          pending={pending}
          collapsed={collapsed.has(group.project.key)}
          onCollapse={() => toggleGroup(group.project.key)}
          selected={selected}
          onToggle={onToggle}
          openId={openId}
          onOpen={onOpen}
          running={running.has(group.project.key)}
          onRun={() => onRun(group.project.key)}
          canWrite={canWrite}
          served={
            registered === null ? null : registered.has(group.project.key)
          }
          autoSkillsOff={autoSkillsOff}
          labels={labels}
        />
      ))}
    </div>
  );
}

function Group({
  group,
  pending,
  collapsed,
  onCollapse,
  selected,
  onToggle,
  openId,
  onOpen,
  running,
  onRun,
  canWrite,
  served,
  autoSkillsOff,
  labels,
}: {
  group: DraftGroup;
  pending: boolean;
  collapsed: boolean;
  onCollapse(): void;
  selected: ReadonlySet<string>;
  onToggle(ids: string[], on: boolean): void;
  openId: string | null;
  onOpen(id: string): void;
  running: boolean;
  onRun(): void;
  canWrite: boolean;
  /** Whether the backend serves this project; null while not known. */
  served: boolean | null;
  autoSkillsOff: boolean;
  labels: Map<string, string>;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const canPick = canWrite && served === true;
  const bodyId = `${id}-drafts`;
  const ids = group.drafts.map((d) => d.proposal_id);
  const picked = ids.filter((d) => selected.has(d)).length;
  const all = ids.length > 0 && picked === ids.length;
  const some = picked > 0 && !all;
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="rounded-lg border border-border bg-card"
    >
      <div className="flex items-center gap-1 px-2 py-1">
        {pending && ids.length > 0 && (
          <label className={CHECKBOX_TARGET}>
            <GroupCheckbox
              checked={all}
              indeterminate={some}
              disabled={!canPick}
              label={`Select all drafts in ${group.label}`}
              onChange={(on) => onToggle(ids, on)}
            />
          </label>
        )}
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={onCollapse}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1.5 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
        >
          <Chevron
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span
            id={labelId}
            className="truncate font-semibold"
          >
            {group.label}
          </span>
          <span className="shrink-0 text-muted-foreground">
            <span aria-hidden="true">· </span>
            {group.drafts.length}
          </span>
        </button>
        {pending && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRun}
            disabled={
              !canWrite ||
              running ||
              served !== true ||
              group.project.missing ||
              autoSkillsOff
            }
            title={autoSkillsOff && !running ? RUN_OFF : undefined}
            className="border-solid max-md:min-h-11"
          >
            {running ? "Running…" : "Run now"}
          </Button>
        )}
      </div>
      <div
        id={bodyId}
        hidden={collapsed}
      >
        {group.drafts.length === 0 ? (
          <p className="px-4 pb-3 pt-1 text-sm text-muted-foreground">
            No drafts waiting.
          </p>
        ) : (
          <ul className="m-0 list-none border-t border-border p-0">
            {group.drafts.map((draft) => (
              <Row
                key={draft.proposal_id}
                draft={draft}
                pending={pending}
                checked={selected.has(draft.proposal_id)}
                onCheck={(on) => onToggle([draft.proposal_id], on)}
                open={draft.proposal_id === openId}
                onOpen={() => onOpen(draft.proposal_id)}
                canPick={canPick}
                labels={labels}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function GroupCheckbox({
  checked,
  indeterminate,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  label: string;
  onChange(on: boolean): void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // `indeterminate` has no attribute, only the property; a click clears it
  // natively, so it is set again after every render.
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  });
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
      className={CHECKBOX}
    />
  );
}

function Row({
  draft,
  pending,
  checked,
  onCheck,
  open,
  onOpen,
  canPick,
  labels,
}: {
  draft: Draft;
  pending: boolean;
  checked: boolean;
  onCheck(on: boolean): void;
  open: boolean;
  onOpen(): void;
  canPick: boolean;
  labels: Map<string, string>;
}) {
  const id = useId();
  const nameId = `${id}-name`;
  const detailsId = `${id}-details`;
  const installed =
    draft.status === "approved" ? installedLabel(draft, labels) : "";
  return (
    <li
      className={cn(
        "mb-0 flex items-start gap-1 border-b border-border px-2 py-1 last:border-b-0",
        open && "bg-[var(--brand-soft)]"
      )}
    >
      {pending && (
        <label className={cn(CHECKBOX_TARGET, "md:mt-1")}>
          <input
            type="checkbox"
            checked={checked}
            disabled={!canPick}
            aria-label={`Select ${draft.skill_name}`}
            onChange={(e) => onCheck(e.target.checked)}
            className={CHECKBOX}
          />
        </label>
      )}
      <button
        type="button"
        onClick={onOpen}
        data-draft-id={draft.proposal_id}
        aria-current={open ? "true" : undefined}
        aria-labelledby={nameId}
        aria-describedby={detailsId}
        className={cn(
          "min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11",
          !pending && "ml-1"
        )}
      >
        <span
          id={nameId}
          className="block break-words text-sm font-medium"
        >
          {draft.skill_name}
        </span>
        <span id={detailsId}>
          {draft.description && (
            <span className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
              {draft.description}
            </span>
          )}
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>
              {draft.operation === "update" ? "updates a skill" : "new skill"}
            </span>
            <span aria-hidden="true">·</span>
            <span>{formatTime(new Date(draft.created_at))}</span>
            {installed && (
              <>
                <span aria-hidden="true">·</span>
                <span>{installed}</span>
              </>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}
