"use client";

// The fields of the Setup view, shared by its form and its wizard. Each one
// reads the saved value from GET /api/settings, shows the unsaved change
// from the draft, and explains why it cannot be edited when it cannot.

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ModelRegistryEntry } from "@/app/hooks/useAvailableModels";
import type { ProviderInfo } from "@/lib/settings";
import {
  currentProvider,
  isEditable,
  modelSuggestions,
  shadowOf,
  type FieldContext,
} from "@/app/components/setupFieldContext";
import {
  KEY_STATUS_TEXT,
  currentText,
  fieldLabel,
  isMaskedSecret,
  sourceNote,
} from "@/lib/settingsForm";
import { cn } from "@/lib/utils";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background py-1.5 pl-2.5 pr-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

function FieldNotes({ ctx, field }: { ctx: FieldContext; field: string }) {
  const shadow = shadowOf(ctx, field);
  const error = ctx.draft.fieldErrors[field];
  const warning = ctx.draft.warnings[field];
  return (
    <>
      {shadow && (
        <p className="text-xs text-muted-foreground">
          Set by {sourceNote(shadow)}, which overrides the saved value. Change
          it there.
        </p>
      )}
      {ctx.payload.read_only.includes(field) && (
        <p className="text-xs text-muted-foreground">
          Changed only with EvoSci config set.
        </p>
      )}
      {error && (
        <p
          id={`${field}-error`}
          role="alert"
          className="text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {warning && (
        <p className="text-xs text-amber-700 dark:text-amber-300">{warning}</p>
      )}
    </>
  );
}

function FieldShell({
  ctx,
  field,
  label,
  description,
  children,
}: {
  ctx: FieldContext;
  field: string;
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "space-y-1.5",
        shadowOf(ctx, field) !== null && "opacity-60"
      )}
    >
      <Label htmlFor={`setting-${field}`}>{label}</Label>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {children}
      <FieldNotes
        ctx={ctx}
        field={field}
      />
    </div>
  );
}

export function ProviderField({ ctx }: { ctx: FieldContext }) {
  const value = currentProvider(ctx);
  const providers = Object.entries(ctx.payload.providers);
  return (
    <FieldShell
      ctx={ctx}
      field="provider"
      label="Provider"
    >
      <select
        id="setting-provider"
        value={value}
        disabled={!isEditable(ctx, "provider")}
        onChange={(e) => ctx.draft.setField("provider", e.target.value, false)}
        className={selectClass}
      >
        {!ctx.payload.providers[value] && (
          <option value={value}>{value}</option>
        )}
        {providers.map(([name, info]) => (
          <option
            key={name}
            value={name}
          >
            {info.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function ModelField({
  ctx,
  registry,
}: {
  ctx: FieldContext;
  registry: ReadonlyArray<ModelRegistryEntry>;
}) {
  const suggestions = modelSuggestions(ctx, registry);
  return (
    <FieldShell
      ctx={ctx}
      field="model"
      label="Model"
      description="Pick a suggestion or type a model name."
    >
      <Input
        id="setting-model"
        list="setting-model-suggestions"
        autoComplete="off"
        spellCheck={false}
        value={currentText(ctx.payload, ctx.draft.edits, "model")}
        disabled={!isEditable(ctx, "model")}
        onChange={(e) => ctx.draft.setField("model", e.target.value, false)}
        aria-invalid={ctx.draft.fieldErrors.model ? true : undefined}
      />
      <datalist id="setting-model-suggestions">
        {suggestions.map((name) => (
          <option
            key={name}
            value={name}
          />
        ))}
      </datalist>
    </FieldShell>
  );
}

export function TextField({
  ctx,
  field,
  label,
  description,
  placeholder,
}: {
  ctx: FieldContext;
  field: string;
  label?: string;
  description?: string;
  placeholder?: string;
}) {
  return (
    <FieldShell
      ctx={ctx}
      field={field}
      label={label ?? fieldLabel(field, ctx.payload.providers)}
      description={description}
    >
      <Input
        id={`setting-${field}`}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={currentText(ctx.payload, ctx.draft.edits, field)}
        disabled={!isEditable(ctx, field)}
        onChange={(e) => ctx.draft.setField(field, e.target.value, false)}
        aria-invalid={ctx.draft.fieldErrors[field] ? true : undefined}
      />
    </FieldShell>
  );
}

/** A key: write-only. The field starts empty (empty keeps the stored key),
 *  the stored one shows only as its hint, and removing it is a button. */
export function SecretField({
  ctx,
  field,
  label,
  check,
}: {
  ctx: FieldContext;
  field: string;
  label?: string;
  check?: { provider: string; baseUrlField: string | null };
}) {
  const saved = ctx.payload.settings[field];
  const stored = isMaskedSecret(saved) && saved.set ? saved : null;
  const edit = ctx.draft.edits[field];
  const removing = field in ctx.draft.edits && edit === null;
  const editable = isEditable(ctx, field);
  const status = stored
    ? `Saved: ${stored.hint ?? "set"}`
    : shadowOf(ctx, field)
    ? null
    : "Not set";
  return (
    <FieldShell
      ctx={ctx}
      field={field}
      label={label ?? fieldLabel(field, ctx.payload.providers)}
    >
      <div className="flex gap-2">
        <Input
          id={`setting-${field}`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            removing
              ? "Will be removed"
              : stored
              ? "Leave empty to keep the saved key"
              : "Paste the key"
          }
          value={typeof edit === "string" ? edit : ""}
          disabled={!editable || removing}
          onChange={(e) => ctx.draft.setField(field, e.target.value, true)}
          aria-invalid={ctx.draft.fieldErrors[field] ? true : undefined}
        />
        {check && (
          <KeyCheckButton
            ctx={ctx}
            provider={check.provider}
            keyField={field}
            baseUrlField={check.baseUrlField}
          />
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {status && <span>{status}</span>}
        {stored && editable && !removing && (
          <button
            type="button"
            onClick={() => ctx.draft.setField(field, null, true)}
            className="rounded px-1 font-medium text-destructive hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Remove
          </button>
        )}
        {removing && (
          <button
            type="button"
            onClick={() => ctx.draft.setField(field, "", true)}
            className="rounded px-1 font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Keep it
          </button>
        )}
      </div>
      {check && (
        <KeyCheckResultText
          ctx={ctx}
          provider={check.provider}
        />
      )}
    </FieldShell>
  );
}

export function KeyCheckButton({
  ctx,
  provider,
  keyField,
  baseUrlField,
}: {
  ctx: FieldContext;
  provider: string;
  keyField: string | null;
  baseUrlField: string | null;
}) {
  const running = ctx.draft.checking[provider] === true;
  return (
    <Button
      type="button"
      variant="outline"
      disabled={!ctx.writable || running}
      onClick={() =>
        void ctx.draft.testKey({ provider, keyField, baseUrlField })
      }
      className="shrink-0"
    >
      {running && (
        <Loader2
          className="size-4 animate-spin"
          aria-hidden="true"
        />
      )}
      {keyField ? "Test key" : "Test connection"}
    </Button>
  );
}

export function KeyCheckResultText({
  ctx,
  provider,
}: {
  ctx: FieldContext;
  provider: string;
}) {
  const result = ctx.draft.checks[provider];
  if (!result) return null;
  if ("error" in result) {
    return (
      <p
        role="status"
        className="text-sm text-destructive"
      >
        {result.error}
      </p>
    );
  }
  return (
    <p
      role="status"
      data-status={result.status}
      className={cn(
        "text-sm",
        result.status === "valid" && "text-emerald-700 dark:text-emerald-300",
        result.status === "invalid" && "text-destructive",
        result.status !== "valid" &&
          result.status !== "invalid" &&
          "text-amber-700 dark:text-amber-300"
      )}
    >
      {KEY_STATUS_TEXT[result.status]}
      {result.message ? ` ${result.message}` : ""}
    </p>
  );
}

/** The key and base URL of one provider, as its `providers` entry asks. */
export function ProviderAccessFields({
  ctx,
  provider,
  info,
}: {
  ctx: FieldContext;
  provider: string;
  info: ProviderInfo;
}) {
  return (
    <>
      {info.base_url_field && (
        <TextField
          ctx={ctx}
          field={info.base_url_field}
          description={
            info.needs_base_url
              ? "Required: the address of the endpoint."
              : "Leave empty to use the provider's default."
          }
        />
      )}
      {info.key_field ? (
        <SecretField
          ctx={ctx}
          field={info.key_field}
          check={
            info.has_check
              ? { provider, baseUrlField: info.base_url_field }
              : undefined
          }
        />
      ) : (
        info.has_check && (
          <div className="space-y-1.5">
            <KeyCheckButton
              ctx={ctx}
              provider={provider}
              keyField={null}
              baseUrlField={info.base_url_field}
            />
            <KeyCheckResultText
              ctx={ctx}
              provider={provider}
            />
          </div>
        )
      )}
    </>
  );
}

export function MirrorField({ ctx }: { ctx: FieldContext }) {
  const checked = currentText(ctx.payload, ctx.draft.edits, "mirror") === "cn";
  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-2">
        <input
          id="setting-mirror"
          type="checkbox"
          checked={checked}
          disabled={!isEditable(ctx, "mirror")}
          onChange={(e) =>
            ctx.draft.setField(
              "mirror",
              e.target.checked ? "cn" : "default",
              false
            )
          }
          aria-describedby="setting-mirror-description"
          className="mt-1 size-4 rounded border-border accent-[var(--brand)]"
        />
        <Label
          htmlFor="setting-mirror"
          className="text-sm font-normal leading-snug"
        >
          Use mainland China mirrors
          <span
            id="setting-mirror-description"
            className="block text-xs text-muted-foreground"
          >
            Applies to later downloads by EvoSci setup, EvoSci update and the
            WebUI&apos;s background update. A registry set in npm wins for the
            WebUI package.
          </span>
        </Label>
      </div>
      <FieldNotes
        ctx={ctx}
        field="mirror"
      />
    </div>
  );
}
