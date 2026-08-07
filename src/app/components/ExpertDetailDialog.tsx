"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatTeamName, type Team } from "@/lib/teams";
import { cn } from "@/lib/utils";
import { iconForHint } from "@/app/components/ExpertsMarketplace";

interface ExpertDetailDialogProps {
  team: Team | null;
  isActive: boolean;
  onClose: () => void;
  onSummon: () => void;
}

/**
 * Team detail modal. Header shows the expert's icon square, title, byline,
 * capability chips as "Expertise". Body renders `description` as "Abilities"
 * prose. Footer holds the Summon/Dismiss CTA.
 *
 * Multi-member team roster is intentionally omitted: `GET /api/teams` does
 * not include `members[]`, so there is no source of truth for it.
 */
export function ExpertDetailDialog({
  team,
  isActive,
  onClose,
  onSummon,
}: ExpertDetailDialogProps) {
  const open = team !== null;
  const Icon = team ? iconForHint(team.avatar_hint) : null;
  const title = team ? formatTeamName(team.name) : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-lg gap-0 p-0">
        <DialogHeader className="border-b border-border p-5">
          <div className="flex items-start gap-4">
            <span
              className={cn(
                "flex size-14 shrink-0 items-center justify-center rounded-lg",
                isActive
                  ? "bg-[var(--brand-solid)] text-[var(--brand-foreground)]"
                  : "bg-muted text-[var(--brand)]"
              )}
              aria-hidden="true"
            >
              {Icon && <Icon className="size-7" />}
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-lg font-semibold leading-tight">
                {title}
              </DialogTitle>
              {team?.byline && (
                <DialogDescription className="mt-1 text-sm">
                  {team.byline}
                </DialogDescription>
              )}
              {team?.capability_tags && team.capability_tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {team.capability_tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="max-h-[50vh] overflow-y-auto p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Abilities
          </h3>
          <p className="mt-2 whitespace-pre-line text-sm leading-6 text-foreground">
            {team?.description}
          </p>
        </div>

        <DialogFooter className="border-t border-border p-4">
          <Button
            type="button"
            variant={isActive ? "outline" : "default"}
            className="w-full"
            onClick={onSummon}
          >
            {isActive ? "Dismiss" : `Summon ${title}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
