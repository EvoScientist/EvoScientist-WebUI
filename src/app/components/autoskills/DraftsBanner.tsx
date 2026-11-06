"use client";

import { useId, type JSX } from "react";
import { useQueryState } from "nuqs";
import { Sparkles } from "lucide-react";
import { readAutoSeenAt, useAutoSkills } from "@/app/hooks/useAutoSkills";
import { Button } from "@/components/ui/button";
import { bannerSummary, timeOf, type Draft } from "@/lib/autoskills";
import type { Project } from "@/lib/projects";
import { formatFullTime } from "@/lib/time";
import { useDeployment } from "@/providers/ClientProvider";
import { useProjects } from "@/providers/ProjectsProvider";

// The top of Research Skills: the drafts waiting for review in every
// project; else the skills AutoSkills installed on its own since the drafts
// page was last opened; else a way into the drafts' history. An
// EvoScientist without the drafts route gets a way to the AutoSkills
// settings only. Nothing while the drafts load or after a failed read.

const NO_PROJECTS: readonly Project[] = [];

const BOX =
  "mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[var(--brand)] bg-[var(--brand-soft)] px-3.5 py-3";
// The quiet states' way in: a small box in the banner's colours, itself
// the button, as wide as its words.
const BOX_BUTTON =
  "inline-flex items-center gap-2 rounded-lg border border-solid border-[var(--brand)] bg-[var(--brand-soft)] px-3 py-1.5 text-sm font-medium text-[var(--brand)] transition-colors focus-visible:ring-2 focus-visible:ring-ring enabled:hover:border-[var(--brand-hover)] enabled:hover:text-[var(--brand-hover)] max-md:min-h-11";

/** How many of the automatic approvals came after `seenAt` (all of them
 *  when nothing was seen); one without a time that parses doesn't count. */
function since(automatic: readonly Draft[], seenAt: string | null): number {
  const seen = seenAt === null ? null : timeOf(seenAt);
  return automatic.filter((d) => {
    const at = d.approved_at === null ? null : timeOf(d.approved_at);
    return at !== null && (seen === null || at > seen);
  }).length;
}

/** A draft's date: month and day, and the year only for another year. */
function shortDate(date: Date): string {
  const otherYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(otherYear ? { year: "numeric" } : {}),
  });
}

export function DraftsBanner(): JSX.Element | null {
  const auto = useAutoSkills();
  const { projects } = useProjects();
  const { deploymentUrl } = useDeployment();
  const [, setSkillsPage] = useQueryState("skillsPage");
  const [, setDraftsTab] = useQueryState("draftsTab");
  const [, setDraftId] = useQueryState("draftId");
  const headlineId = useId();

  const openDrafts = (tab: "approved" | null) => {
    void setSkillsPage("drafts");
    void setDraftsTab(tab);
    void setDraftId(null);
  };

  if (auto.status === "loading" || auto.status === "error") return null;

  if (auto.status === "unsupported") {
    return (
      <div className="mb-4">
        <button
          type="button"
          onClick={() => {
            void setSkillsPage("drafts");
            void setDraftsTab(null);
          }}
          className={BOX_BUTTON}
        >
          <Sparkles
            className="size-4 shrink-0"
            aria-hidden="true"
          />
          AutoSkills settings
        </button>
      </div>
    );
  }

  const { list } = auto;
  const { pending, split, latest } = bannerSummary(
    list,
    projects.status === "ready" ? projects.projects : NO_PROJECTS
  );

  if (pending > 0) {
    const waiting = "waiting for your review";
    return (
      <div className={BOX}>
        <Sparkles
          className="size-5 shrink-0 text-[var(--brand)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 text-sm">
          <p
            id={headlineId}
            className="mb-0 font-medium"
          >
            {pending === 1
              ? "1 skill drafted from your memory"
              : `${pending} skills drafted from your memory`}
          </p>
          {split.length > 0 && (
            <p className="mb-0 text-muted-foreground">
              {split.map((s) => `${s.label} ${s.count}`).join(" · ")}
            </p>
          )}
          <p
            className="text-muted-foreground"
            title={latest ? formatFullTime(new Date(latest)) : undefined}
          >
            {latest
              ? `Latest ${shortDate(new Date(latest))} · ${waiting}`
              : waiting}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          aria-describedby={headlineId}
          onClick={() => openDrafts(null)}
          className="max-md:min-h-11"
        >
          Review
        </Button>
      </div>
    );
  }

  // Read only when there is something to place after the last visit.
  const automatic = list.drafts.filter(
    (d) => d.status === "approved" && d.approved_by === "auto"
  );
  const installed =
    automatic.length > 0 ? since(automatic, readAutoSeenAt(deploymentUrl)) : 0;

  if (installed > 0) {
    return (
      <div className={BOX}>
        <Sparkles
          className="size-5 shrink-0 text-[var(--brand)]"
          aria-hidden="true"
        />
        <p
          id={headlineId}
          className="mb-0 min-w-0 flex-1 text-sm font-medium"
        >
          {installed === 1
            ? "AutoSkills installed 1 skill automatically"
            : `AutoSkills installed ${installed} skills automatically`}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-describedby={headlineId}
          onClick={() => openDrafts("approved")}
          className="border-solid max-md:min-h-11"
        >
          See them
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => openDrafts("approved")}
        className={BOX_BUTTON}
      >
        <Sparkles
          className="size-4 shrink-0"
          aria-hidden="true"
        />
        AutoSkills history
      </button>
    </div>
  );
}
