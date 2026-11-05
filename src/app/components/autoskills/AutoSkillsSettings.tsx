"use client";

import { useState, type RefObject } from "react";
import { toast } from "sonner";
import { focusFirst } from "@/app/components/autoskills/focus";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { autoSkillsReadOnlyReason } from "@/lib/autoskills";
import { INPUT_LIKE_TRIGGER, LIST_MAX_HEIGHT } from "@/lib/fieldStyles";
import { saveErrorText } from "@/lib/settingsForm";
import { cn } from "@/lib/utils";

// The AutoSkills settings from the drafts page's Settings button: a panel on
// the right. Saves go through the WebUI's relay like the Settings page, and
// the core applies them at once (no restart).

const F_ENABLED = "memory_skill_synthesis_enabled";
const F_MODE = "memory_skill_synthesis_mode";
const F_CADENCE = "memory_skill_synthesis_cadence";
const F_TIME = "memory_skill_synthesis_time";

type Mode = "review" | "auto";
type Cadence = "nightly" | "weekly" | "monthly";

interface Values {
  [F_ENABLED]: boolean;
  [F_MODE]: Mode;
  [F_CADENCE]: Cadence;
  [F_TIME]: string;
}
type Field = keyof Values;

const FIELDS: readonly Field[] = [F_ENABLED, F_MODE, F_CADENCE, F_TIME];

const CADENCES: ReadonlyArray<{ value: Cadence; label: string }> = [
  { value: "nightly", label: "Nightly" },
  { value: "weekly", label: "Weekly (Sundays)" },
  { value: "monthly", label: "Monthly (on the 1st)" },
];

const MODES: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: "review", label: "Review — I approve each skill" },
  { value: "auto", label: "Auto — install drafts without asking" },
];

/** The saved values, with the core's defaults for what is missing. */
function savedValues(settings: Record<string, unknown> | undefined): Values {
  const s = settings ?? {};
  const mode = s[F_MODE];
  const cadence = s[F_CADENCE];
  const time = s[F_TIME];
  return {
    [F_ENABLED]: s[F_ENABLED] === false ? false : true,
    [F_MODE]: mode === "auto" ? "auto" : "review",
    [F_CADENCE]:
      cadence === "nightly" || cadence === "monthly" ? cadence : "weekly",
    [F_TIME]: typeof time === "string" && time ? time : "03:00",
  };
}

function validTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

const CHECKBOX =
  "size-4 rounded border border-muted-foreground bg-transparent text-[var(--brand-solid)] focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const TOUCH_ROW = "max-md:min-h-11";

export function AutoSkillsSettings({
  open,
  onOpenChange,
  returnFocusTo,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Where the focus goes when the panel closes (Safari doesn't focus a
   *  clicked button, so Radix's own return can't be relied on). */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const { payload, refresh } = useSettings();
  const { access } = useSettingsAccess();
  const saved = savedValues(payload?.settings);
  const tz = payload?.settings?.scheduler_default_timezone;
  const timezone = typeof tz === "string" ? tz.trim() : "";

  const [edits, setEdits] = useState<Partial<Values>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Each opening starts from what is saved.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setEdits({});
      setMessage(null);
      setServerErrors({});
    }
  }

  const values: Values = { ...saved, ...edits };
  const changed = FIELDS.filter((f) => values[f] !== saved[f]);
  const timeBad = !validTime(values[F_TIME]);
  const timeError = timeBad ? "Enter a time like 03:00." : serverErrors[F_TIME];

  const writable = access?.writable === true;
  const reason = autoSkillsReadOnlyReason(access);
  const locked = !writable || saving;
  const off = !values[F_ENABLED];

  const edit = <K extends Field>(field: K, value: Values[K]) => {
    setEdits((prev) => ({ ...prev, [field]: value }));
    setServerErrors((prev) => {
      if (!(field in prev)) return prev;
      const { [field]: _gone, ...rest } = prev;
      void _gone;
      return rest;
    });
  };

  const canSave = writable && !saving && changed.length > 0 && !timeBad;

  const save = async () => {
    if (!canSave) return;
    const body: Record<string, unknown> = {};
    for (const f of changed) body[f] = values[f];
    body.revision = payload?.revision ?? null;
    setSaving(true);
    setMessage(null);
    setServerErrors({});
    try {
      let res: Response;
      try {
        res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        setMessage("The WebUI server did not answer. Nothing was saved.");
        return;
      }
      const answer: unknown = await res.json().catch(() => null);
      if (res.ok) {
        await refresh();
        onOpenChange(false);
        toast.success("AutoSkills settings saved.");
        return;
      }
      const code =
        typeof answer === "object" && answer !== null
          ? (answer as { error?: unknown }).error
          : undefined;
      if (res.status === 409 && code === "revision_mismatch") {
        setEdits({});
        await refresh();
        setMessage(
          "These settings changed elsewhere. Showing what is saved now."
        );
        return;
      }
      const errors =
        typeof answer === "object" && answer !== null
          ? (answer as { errors?: unknown }).errors
          : undefined;
      if (res.status === 400 && typeof errors === "object" && errors) {
        setServerErrors(errors as Record<string, string>);
        return;
      }
      setMessage(saveErrorText(answer, res.status));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent
        onCloseAutoFocus={(e) => {
          if (!returnFocusTo) return;
          e.preventDefault();
          focusFirst([returnFocusTo.current]);
        }}
        className={cn(
          "left-auto right-0 top-0 h-dvh max-h-dvh w-full translate-x-0 translate-y-0 content-start rounded-none border-y-0 border-r-0 border-solid max-md:max-w-full sm:max-w-sm",
          "data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right"
        )}
      >
        <DialogHeader>
          <DialogTitle>AutoSkills settings</DialogTitle>
          <DialogDescription>
            Saved to config.yaml for every project. Applies at once, no restart.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <label className={cn("flex items-center gap-2 text-sm", TOUCH_ROW)}>
            <input
              type="checkbox"
              checked={values[F_ENABLED]}
              disabled={locked}
              onChange={(e) => edit(F_ENABLED, e.target.checked)}
              className={CHECKBOX}
            />
            Draft skills from memory
          </label>

          <fieldset
            disabled={locked || off}
            className="m-0 min-w-0 space-y-1 border-0 p-0"
          >
            <legend className="mb-1 text-sm font-medium">Mode</legend>
            {MODES.map((m) => (
              <label
                key={m.value}
                className={cn(
                  "flex items-center gap-2 text-sm",
                  TOUCH_ROW,
                  (locked || off) && "opacity-60"
                )}
              >
                <input
                  type="radio"
                  name="autoskills-mode"
                  value={m.value}
                  checked={values[F_MODE] === m.value}
                  disabled={locked || off}
                  onChange={() => edit(F_MODE, m.value)}
                  className="size-4 border border-muted-foreground bg-transparent text-[var(--brand-solid)] focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                />
                {m.label}
              </label>
            ))}
            {serverErrors[F_MODE] && (
              <p
                role="alert"
                className="text-sm text-destructive"
              >
                {serverErrors[F_MODE]}
              </p>
            )}
          </fieldset>

          <div className="space-y-1">
            <Label htmlFor="autoskills-cadence">How often</Label>
            <Select
              value={values[F_CADENCE]}
              disabled={locked || off}
              onValueChange={(next) => {
                if (next) edit(F_CADENCE, next as Cadence);
              }}
            >
              <SelectTrigger
                id="autoskills-cadence"
                className={cn(INPUT_LIKE_TRIGGER, "w-full max-md:min-h-11")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={LIST_MAX_HEIGHT}>
                {CADENCES.map((c) => (
                  <SelectItem
                    key={c.value}
                    value={c.value}
                  >
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {serverErrors[F_CADENCE] && (
              <p
                role="alert"
                className="text-sm text-destructive"
              >
                {serverErrors[F_CADENCE]}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="autoskills-time">
              {timezone ? `At (${timezone})` : "At (local time)"}
            </Label>
            <input
              id="autoskills-time"
              type="time"
              value={values[F_TIME]}
              disabled={locked || off}
              onChange={(e) => edit(F_TIME, e.target.value)}
              aria-invalid={timeError ? true : undefined}
              className="h-9 w-full rounded-md border border-solid border-input bg-transparent px-3 py-1 text-base shadow-xs focus:ring-0 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 max-md:min-h-11 md:text-sm"
            />
            {timeError && (
              <p
                role="alert"
                className="text-sm text-destructive"
              >
                {timeError}
              </p>
            )}
          </div>

          {access && reason && (
            <p className="text-sm text-muted-foreground">{reason}</p>
          )}
          {message && (
            <p
              role="status"
              className="text-sm text-muted-foreground"
            >
              {message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-solid max-md:min-h-11"
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSave}
            onClick={() => void save()}
            className="bg-[var(--brand-solid)] text-white hover:bg-[var(--brand-hover)] max-md:min-h-11"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
