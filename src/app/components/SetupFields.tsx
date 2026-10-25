"use client";

// The fields of the Setup view, shared by its form and its wizard. Each one
// reads the saved value from GET /api/settings, shows the unsaved change
// from the draft, and explains why it cannot be edited when it cannot.

import { useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAvailableModels,
  type ModelRegistryEntry,
} from "@/app/hooks/useAvailableModels";
import type { ProviderInfo } from "@/lib/settings";
import {
  currentProvider,
  isEditable,
  keyShadowOf,
  modelSuggestions,
  shadowOf,
  type FieldContext,
} from "@/app/components/setupFieldContext";
import {
  currentText,
  keyStatusText,
  fieldLabel,
  isMaskedSecret,
  modelForProvider,
  savedText,
  sourceNote,
} from "@/lib/settingsForm";
import { INPUT_LIKE_TRIGGER, LIST_MAX_HEIGHT } from "@/lib/fieldStyles";
import { cn } from "@/lib/utils";

function FieldNotes({ ctx, field }: { ctx: FieldContext; field: string }) {
  const shadow = shadowOf(ctx, field);
  const keyShadow = keyShadowOf(ctx, field);
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
      {keyShadow && (
        <p className="text-xs text-muted-foreground">
          Its API key is set by {sourceNote(keyShadow)}, so the address is
          changed only with EvoSci config set.
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
  const { registry } = useAvailableModels();
  const value = currentProvider(ctx);
  const providers = Object.entries(ctx.payload.providers);
  // A new provider gets a model it serves, as EvoSci onboard picks it; the
  // one kept from the last provider would be asked of the new one.
  const choose = (provider: string) => {
    ctx.draft.setField("provider", provider, false);
    if (!isEditable(ctx, "model")) return;
    const model = modelForProvider(
      [
        currentText(ctx.payload, ctx.draft.edits, "model"),
        savedText(ctx.payload, "model"),
      ],
      ctx.payload.providers[provider],
      registry.entries.filter((e) => e.provider === provider).map((e) => e.name)
    );
    ctx.draft.setField("model", model, false);
  };
  return (
    <FieldShell
      ctx={ctx}
      field="provider"
      label="Provider"
    >
      {/* Pick-only, in the same in-page list as the model's menu (a native
          <select> opens the system's own popup). */}
      <Select
        // Always controlled: "" shows the placeholder, while `undefined` would
        // let Radix keep a pick that Discard has dropped.
        value={value}
        // No item has the value "": in a form Radix also renders a hidden
        // native <select>, which reports "" once when an unknown saved provider
        // and its item arrive together (Discard, a re-read). Not a pick.
        onValueChange={(next) => {
          if (next) choose(next);
        }}
        disabled={!isEditable(ctx, "provider")}
      >
        <SelectTrigger
          id="setting-provider"
          className={INPUT_LIKE_TRIGGER}
        >
          <SelectValue placeholder="Choose a provider" />
        </SelectTrigger>
        <SelectContent className={LIST_MAX_HEIGHT}>
          {value && !ctx.payload.providers[value] && (
            <SelectItem value={value}>{value}</SelectItem>
          )}
          {providers.map(([name, info]) => (
            <SelectItem
              key={name}
              value={name}
            >
              {info.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
  const value = currentText(ctx.payload, ctx.draft.edits, "model");
  const editable = isEditable(ctx, "model");
  // The menu spans the field, as the provider's list does.
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const [menuWidth, setMenuWidth] = useState<number | undefined>(undefined);
  // A menu of every suggestion next to a free text field: a <datalist>
  // shows only the options that match what the field already holds, so a
  // prefilled model hid the whole list.
  return (
    <FieldShell
      ctx={ctx}
      field="model"
      label="Model"
      description="Pick one from the list or type a model name."
    >
      <div
        ref={fieldRef}
        className="relative"
      >
        <Input
          id="setting-model"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={!editable}
          onChange={(e) => ctx.draft.setField("model", e.target.value, false)}
          aria-invalid={ctx.draft.fieldErrors.model ? true : undefined}
          className="pr-10"
        />
        <DropdownMenu
          modal={false}
          onOpenChange={(open) => {
            if (open) setMenuWidth(fieldRef.current?.offsetWidth);
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={!editable || suggestions.length === 0}
              aria-label="Choose from the model list"
              title={
                suggestions.length === 0
                  ? "No models listed for this provider; type a name"
                  : "Choose from the model list"
              }
              // Inside the field's border, the chevron where the provider
              // list has its own (12 px padding + 1 px border).
              className="absolute inset-y-px right-px flex w-10 items-center justify-center rounded-r-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronDown
                className="h-4 w-4 opacity-50"
                aria-hidden="true"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))]"
            style={menuWidth ? { width: menuWidth } : undefined}
          >
            {suggestions.map((name) => (
              <DropdownMenuItem
                key={name}
                onSelect={() => ctx.draft.setField("model", name, false)}
              >
                {name === value ? (
                  <Check aria-hidden="true" />
                ) : (
                  <span
                    className="size-4"
                    aria-hidden="true"
                  />
                )}
                {name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
  keyless = false,
}: {
  ctx: FieldContext;
  provider: string;
  /** The check proves a server, not a key (Ollama). */
  keyless?: boolean;
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
      {keyStatusText(result.status, keyless)}
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
              keyless
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
          className="mt-1 size-4 rounded border border-muted-foreground bg-transparent text-[var(--brand-solid)] focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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

/** Save errors for fields this view does not show (a wizard step or the
 *  form left them out), so a refused save is never silent. */
export function UnplacedErrors({
  ctx,
  shown,
}: {
  ctx: FieldContext;
  shown: (field: string) => boolean;
}) {
  const unplaced = Object.entries(ctx.draft.fieldErrors).filter(
    ([field]) => !shown(field)
  );
  if (unplaced.length === 0) return null;
  return (
    <div
      role="alert"
      className="space-y-1 text-sm text-destructive"
    >
      {unplaced.map(([field, error]) => (
        <p key={field}>
          {fieldLabel(field, ctx.payload.providers)}: {error}
        </p>
      ))}
    </div>
  );
}
