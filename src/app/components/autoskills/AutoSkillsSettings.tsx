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
import {
  isSettingsPayload,
  type SettingSource,
  type SettingsPayload,
} from "@/lib/settings";
import { saveErrorText, shadowedSource, sourceNote } from "@/lib/settingsForm";
import { cn } from "@/lib/utils";

// The AutoSkills settings from the drafts page's Settings button: a panel on
// the right. Saves go through the WebUI's relay like the Settings page, and
// the core applies them at once (no restart). A field an environment
// variable overrides in the running core is off here, as on the Settings
// page: saving it would change nothing there.

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

/** The fields an override hides in the running core, with where each
 *  override comes from. */
function overridesOf(
  payload: SettingsPayload | null
): Partial<Record<Field, SettingSource>> {
  const out: Partial<Record<Field, SettingSource>> = {};
  if (!payload) return out;
  for (const f of FIELDS) {
    const source = shadowedSource(payload, f);
    if (source) out[f] = source;
  }
  return out;
}

const NOTE_ID: Record<Field, string> = {
  [F_ENABLED]: "autoskills-enabled-override",
  [F_MODE]: "autoskills-mode-override",
  [F_CADENCE]: "autoskills-cadence-override",
  [F_TIME]: "autoskills-time-override",
};

/** The Setup page's note under a field an override hides, in its words. */
function OverrideNote({
  field,
  source,
}: {
  field: Field;
  source: SettingSource | undefined;
}) {
  if (!source) return null;
  return (
    <p
      id={NOTE_ID[field]}
      className="text-xs text-muted-foreground"
    >
      Set by {sourceNote(source)}, which overrides the saved value. Change it
      there.
    </p>
  );
}

/** A settings answer the panel takes as what is saved: the real core always
 *  sends `revision`, a string or null (no config.yaml yet). One without the
 *  key is malformed and neither shown as saved nor a successful re-read. */
function withRevision(value: unknown): value is SettingsPayload {
  if (!isSettingsPayload(value)) return false;
  const answer = value as unknown as Record<string, unknown>;
  return (
    "revision" in answer &&
    (typeof answer.revision === "string" || answer.revision === null)
  );
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
  // The saved snapshot is the last real settings payload seen: a re-read
  // that answers nothing (404, an error) or a malformed body must not swap
  // it for defaults. Its key holds the sources too: an override comes and
  // goes with the same settings and revision (config.yaml untouched), and
  // an older snapshot would open a control the override has closed.
  const real = withRevision(payload) ? payload : null;
  const realKey = real
    ? JSON.stringify([real.settings, real.revision, real.sources])
    : null;
  const [snap, setSnap] = useState({ key: realKey, payload: real });
  if (real && realKey !== snap.key) setSnap({ key: realKey, payload: real });
  const current = real ?? snap.payload;
  const saved = savedValues(current?.settings);
  const tz = current?.settings?.scheduler_default_timezone;
  const timezone = typeof tz === "string" ? tz.trim() : "";

  const [edits, setEdits] = useState<Partial<Values>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // The revision each pending edit started from, in the order they began: a
  // re-read in between must not let the save overwrite what changed
  // elsewhere. The save sends the earliest still-pending one.
  const [revs, setRevs] = useState<Partial<Record<Field, string | null>>>({});

  // Each opening starts from what is saved.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setEdits({});
      setRevs({});
      setMessage(null);
      setServerErrors({});
    }
  }

  // When the saved values change under the panel (a re-read), an edit that
  // now equals its saved value is no longer an edit; with none left the base
  // revision is forgotten, so the next edit starts from the current one.
  const savedKey = JSON.stringify(saved);
  const [seenSaved, setSeenSaved] = useState(savedKey);
  if (seenSaved !== savedKey) {
    setSeenSaved(savedKey);
    const kept: Partial<Values> = {};
    const keptRevs: Partial<Record<Field, string | null>> = {};
    for (const f of FIELDS) {
      if (f in edits && edits[f] !== saved[f]) {
        (kept as Record<string, unknown>)[f] = edits[f];
      }
    }
    for (const f of Object.keys(revs) as Field[]) {
      if (f in kept) keptRevs[f] = revs[f];
    }
    if (Object.keys(kept).length !== Object.keys(edits).length) {
      setEdits(kept);
      setRevs(keptRevs);
    }
  }

  // What an override hides in the running core. Such a field shows what is
  // saved and takes no input; an edit made before the override showed
  // doesn't count, so it is never sent.
  const overrides = overridesOf(current);
  const live: Partial<Values> = {};
  for (const f of FIELDS) {
    if (f in edits && !overrides[f]) {
      (live as Record<string, unknown>)[f] = edits[f];
    }
  }
  const values: Values = { ...saved, ...live };
  const changed = FIELDS.filter((f) => values[f] !== saved[f]);
  // Off as far as the page knows: with on / off overridden it doesn't, and
  // the other fields stay open.
  const off = !values[F_ENABLED] && !overrides[F_ENABLED];
  // With drafting on a bad time blocks Save. With it off, or overridden,
  // the time field is disabled and can't be fixed, so it doesn't, and a
  // changed time goes out only when it is valid.
  const timeBad = !validTime(values[F_TIME]);
  const timeBlocks = timeBad && !off && !overrides[F_TIME];
  const timeError = timeBlocks
    ? "Enter a time like 03:00."
    : serverErrors[F_TIME];
  const sendable = changed.filter((f) => f !== F_TIME || !timeBad);

  const writable = access?.writable === true;
  const reason = autoSkillsReadOnlyReason(access);
  const locked = !writable || saving;

  const edit = <K extends Field>(field: K, value: Values[K]) => {
    const next: Partial<Values> = { ...edits, [field]: value };
    // Changed back to the saved value: not an edit.
    if (value === saved[field]) delete next[field];
    const nextRevs = { ...revs };
    if (field in next) {
      if (!(field in edits)) nextRevs[field] = current?.revision ?? null;
    } else {
      delete nextRevs[field];
    }
    setRevs(nextRevs);
    setEdits(next);
    setServerErrors((prev) => {
      if (!(field in prev)) return prev;
      const { [field]: _gone, ...rest } = prev;
      void _gone;
      return rest;
    });
  };

  const canSave = writable && !saving && sendable.length > 0 && !timeBlocks;

  const save = async () => {
    if (!canSave) return;
    const body: Record<string, unknown> = {};
    for (const f of sendable) body[f] = values[f];
    // The oldest base among the edits that go out: one that can't be sent
    // (a bad time while drafting is off) doesn't hold an older revision.
    const first = (Object.keys(revs) as Field[]).find((f) =>
      sendable.includes(f)
    );
    const sentRevision = first === undefined ? null : revs[first] ?? null;
    body.revision = sentRevision;
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
        // The relay may have passed the save on before its answer was
        // lost: never "nothing was saved". The settings are read again, in
        // the background (the browser reads them from the backend itself);
        // a save that did go through then shows as saved, its edits gone.
        setMessage(
          "The WebUI server did not answer, so the page can't tell whether the settings were saved. They are being read again."
        );
        try {
          void Promise.resolve(refresh()).catch(() => {});
        } catch {
          // ignore
        }
        return;
      }
      const answer: unknown = await res.json().catch(() => null);
      if (res.ok) {
        setEdits({});
        setRevs({});
        // The save happened: close and say so now; the re-read runs on its
        // own, and neither a failure nor a hang touches the panel.
        onOpenChange(false);
        toast.success("AutoSkills settings saved.");
        try {
          void Promise.resolve(refresh()).catch(() => {});
        } catch {
          // ignore
        }
        return;
      }
      const code =
        typeof answer === "object" && answer !== null
          ? (answer as { error?: unknown }).error
          : undefined;
      if (res.status === 409 && code === "revision_mismatch") {
        // The revision saved now, as the conflict names it (the core's 409
        // carries it, a string or null).
        const named =
          typeof answer === "object" &&
          answer !== null &&
          "revision" in answer &&
          (typeof answer.revision === "string" || answer.revision === null)
            ? { revision: answer.revision }
            : null;
        let fresh: unknown;
        try {
          fresh = await refresh();
        } catch {
          fresh = undefined;
        }
        // SWR's mutate answers with the cached payload when the read fails:
        // only an answer with the named revision (without one, any other
        // than the one sent) is a new read.
        const reread =
          withRevision(fresh) &&
          (named
            ? fresh.revision === named.revision
            : fresh.revision !== sentRevision);
        if (reread) {
          setEdits({});
          setRevs({});
          setMessage(
            "These settings changed elsewhere. Showing what is saved now."
          );
        } else {
          setMessage(
            "These settings changed elsewhere, and reading them again failed. Your changes are kept; try again."
          );
        }
        return;
      }
      const errors =
        typeof answer === "object" && answer !== null
          ? (answer as { errors?: unknown }).errors
          : undefined;
      if (res.status === 400 && typeof errors === "object" && errors) {
        const byField = errors as Record<string, string>;
        const shown = new Set<string>([F_MODE, F_CADENCE, F_TIME]);
        setServerErrors(byField);
        const other = Object.entries(byField)
          .filter(([k]) => !shown.has(k))
          .map(([, m]) => String(m));
        if (other.length > 0) setMessage(other.join("\n"));
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
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent
        onCloseAutoFocus={(e) => {
          if (!returnFocusTo) return;
          e.preventDefault();
          focusFirst([returnFocusTo.current]);
        }}
        className={cn(
          "left-auto right-0 top-0 h-dvh max-h-dvh w-full max-w-full translate-x-0 translate-y-0 content-start rounded-none border-y-0 border-r-0 border-solid sm:max-w-full md:max-w-sm",
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
          <div className="space-y-1">
            <label
              className={cn(
                "flex items-center gap-2 text-sm",
                TOUCH_ROW,
                overrides[F_ENABLED] && "opacity-60"
              )}
            >
              <input
                type="checkbox"
                checked={values[F_ENABLED]}
                disabled={locked || !!overrides[F_ENABLED]}
                onChange={(e) => edit(F_ENABLED, e.target.checked)}
                aria-describedby={
                  overrides[F_ENABLED] ? NOTE_ID[F_ENABLED] : undefined
                }
                className={CHECKBOX}
              />
              Draft skills from memory
            </label>
            <OverrideNote
              field={F_ENABLED}
              source={overrides[F_ENABLED]}
            />
          </div>

          <fieldset
            disabled={locked || off || !!overrides[F_MODE]}
            aria-describedby={overrides[F_MODE] ? NOTE_ID[F_MODE] : undefined}
            className="m-0 min-w-0 space-y-1 border-0 p-0"
          >
            <legend className="mb-1 text-sm font-medium">Mode</legend>
            {MODES.map((m) => (
              <label
                key={m.value}
                className={cn(
                  "flex items-center gap-2 text-sm",
                  TOUCH_ROW,
                  (locked || off || overrides[F_MODE]) && "opacity-60"
                )}
              >
                <input
                  type="radio"
                  name="autoskills-mode"
                  value={m.value}
                  checked={values[F_MODE] === m.value}
                  disabled={locked || off || !!overrides[F_MODE]}
                  onChange={() => edit(F_MODE, m.value)}
                  className="size-4 border border-muted-foreground bg-transparent text-[var(--brand-solid)] focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                />
                {m.label}
              </label>
            ))}
            <OverrideNote
              field={F_MODE}
              source={overrides[F_MODE]}
            />
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
              disabled={locked || off || !!overrides[F_CADENCE]}
              onValueChange={(next) => {
                if (next) edit(F_CADENCE, next as Cadence);
              }}
            >
              <SelectTrigger
                id="autoskills-cadence"
                aria-describedby={
                  overrides[F_CADENCE] ? NOTE_ID[F_CADENCE] : undefined
                }
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
            <OverrideNote
              field={F_CADENCE}
              source={overrides[F_CADENCE]}
            />
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
              disabled={locked || off || !!overrides[F_TIME]}
              onChange={(e) => edit(F_TIME, e.target.value)}
              aria-invalid={timeError ? true : undefined}
              aria-describedby={
                [
                  overrides[F_TIME] ? NOTE_ID[F_TIME] : null,
                  timeError ? "autoskills-time-error" : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              className="h-9 w-full rounded-md border border-solid border-input bg-transparent px-3 py-1 text-base shadow-xs focus:ring-0 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 max-md:min-h-11 md:text-sm"
            />
            <OverrideNote
              field={F_TIME}
              source={overrides[F_TIME]}
            />
            {timeError && (
              <p
                id="autoskills-time-error"
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
              className="whitespace-pre-line text-sm text-muted-foreground"
            >
              {message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => onOpenChange(false)}
            className="border-solid max-md:min-h-11"
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSave}
            onClick={() => void save()}
            className="max-md:min-h-11"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
