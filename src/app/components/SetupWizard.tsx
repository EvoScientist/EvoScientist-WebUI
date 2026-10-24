"use client";

// The first-run setup wizard: the Setup view's fields one step at a time,
// then one save. It opens by itself when GET /api/settings says
// `setup_needed` and the page can save (useSetupGate); "Configure later"
// goes back to the chat, which then shows a notice that links here.

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ModelRegistryEntry } from "@/app/hooks/useAvailableModels";
import {
  ModelField,
  MirrorField,
  ProviderAccessFields,
  ProviderField,
  SecretField,
  TextField,
  UnplacedErrors,
} from "@/app/components/SetupFields";
import {
  currentProvider,
  isEditable,
  shadowOf,
  type FieldContext,
} from "@/app/components/setupFieldContext";
import {
  currentText,
  fieldLabel,
  isMaskedSecret,
  sourceNote,
  stepOfField,
  wizardSteps,
  type WizardStep,
} from "@/lib/settingsForm";
import type { SaveResult } from "@/app/hooks/useSettingsDraft";

const STEP_TITLES: Record<WizardStep, string> = {
  provider: "Choose a provider",
  key: "Connect to it",
  model: "Choose a model",
  tavily: "Search (optional)",
  folder: "Workspace and mirrors",
  summary: "Check and finish",
};

interface SetupWizardProps {
  ctx: FieldContext;
  registry: ReadonlyArray<ModelRegistryEntry>;
  defaultFolder?: string;
  onConfigureLater: () => void;
  onFinished: (result: SaveResult) => void;
}

export function SetupWizard({
  ctx,
  registry,
  defaultFolder,
  onConfigureLater,
  onFinished,
}: SetupWizardProps) {
  const provider = currentProvider(ctx);
  const info = ctx.payload.providers[provider];
  const steps = wizardSteps(info);
  const [stepName, setStepName] = useState<WizardStep>("provider");
  // The provider decides which steps exist; a step that no longer does
  // (Ollama has no key step) falls back to the first.
  const index = Math.max(0, steps.indexOf(stepName));
  const step = steps[index];
  const { edits } = ctx.draft;

  const keySet = (field: string | null) => {
    if (!field) return true;
    const typed = edits[field];
    if (typeof typed === "string" && typed) return true;
    if (field in edits) return false; // being removed
    const saved = ctx.payload.settings[field];
    return (
      (isMaskedSecret(saved) && saved.set) ||
      ctx.payload.sources[field]?.shadowed === true
    );
  };

  const blocker = (s: WizardStep): string | null => {
    // A saved provider EvoScientist no longer knows has no key step.
    if (s === "provider" && !info) return "Choose a provider.";
    if (s === "key" && info) {
      if (
        info.needs_base_url &&
        info.base_url_field &&
        !currentText(ctx.payload, edits, info.base_url_field)
      ) {
        return "Enter the endpoint's address.";
      }
      if (info.needs_key && !keySet(info.key_field)) {
        return "Enter the API key.";
      }
    }
    if (s === "model" && !currentText(ctx.payload, edits, "model")) {
      return "Choose or type a model.";
    }
    return null;
  };
  const localErrors = Object.keys(ctx.draft.fieldErrors).some(
    (field) => stepOfField(field, info) === step
  );
  const stepBlocker = blocker(step);

  const goTo = (s: WizardStep) => setStepName(s);
  const offeredFolder = useRef(false);
  const next = () => {
    // The desktop app suggests a folder; offer it on the first visit of the
    // folder step when no folder is saved, so a folder the user emptied (a
    // saved one included) stays empty.
    const nextStep = steps[index + 1];
    if (nextStep === "folder" && !offeredFolder.current) {
      offeredFolder.current = true;
      if (
        defaultFolder &&
        isEditable(ctx, "default_workdir") &&
        !currentText(ctx.payload, edits, "default_workdir")
      ) {
        ctx.draft.setField("default_workdir", defaultFolder, false);
      }
    }
    goTo(nextStep);
  };

  // The model step offers what the server lists (Ollama, the custom
  // endpoints): check it on the way in unless that was done on the step
  // before.
  const { checks, checking, testKey } = ctx.draft;
  const listModels =
    step === "model" &&
    info?.lists_models === true &&
    info.has_check &&
    !checks[provider] &&
    !checking[provider];
  useEffect(() => {
    if (!listModels || !info) return;
    void testKey({
      provider,
      keyField: info.key_field,
      baseUrlField: info.base_url_field,
    });
  }, [listModels, info, provider, testKey]);

  const finish = async () => {
    const outcome = await ctx.draft.save();
    if (outcome.ok) {
      onFinished(outcome.result);
      return;
    }
    // Show the first error where its field is.
    const first = Object.keys(outcome.fieldErrors)[0];
    if (first) goTo(stepOfField(first, info));
  };

  return (
    <section
      aria-label="Setup wizard"
      className="rounded-lg border border-border bg-card p-4 sm:p-5"
    >
      <p className="text-xs font-medium text-muted-foreground">
        Step {index + 1} of {steps.length}
      </p>
      <h3 className="mt-1 text-base font-semibold">{STEP_TITLES[step]}</h3>

      <div className="mt-4 space-y-4">
        {step === "provider" && <ProviderField ctx={ctx} />}
        {step === "key" && info && (
          <ProviderAccessFields
            ctx={ctx}
            provider={provider}
            info={info}
          />
        )}
        {step === "model" && (
          <ModelField
            ctx={ctx}
            registry={registry}
          />
        )}
        {step === "tavily" && (
          <>
            <p className="text-sm text-muted-foreground">
              Without a Tavily key, web search is off. You can add one later in
              Settings.
            </p>
            <SecretField
              ctx={ctx}
              field="tavily_api_key"
              check={{ provider: "tavily", baseUrlField: null }}
            />
          </>
        )}
        {step === "folder" && (
          <>
            <TextField
              ctx={ctx}
              field="default_workdir"
              description="Where EvoScientist keeps its work. Leave empty for the folder it starts in."
            />
            <MirrorField ctx={ctx} />
          </>
        )}
        {step === "summary" && (
          <Summary
            ctx={ctx}
            steps={steps}
            onEdit={goTo}
          />
        )}
      </div>

      {ctx.draft.message && (
        <p
          role="alert"
          className="mt-4 text-sm text-destructive"
        >
          {ctx.draft.message}
        </p>
      )}
      <div className="mt-4">
        <UnplacedErrors
          ctx={ctx}
          shown={(field) => stepOfField(field, info) !== "summary"}
        />
      </div>
      {stepBlocker && (
        <p className="mt-4 text-xs text-muted-foreground">{stepBlocker}</p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onConfigureLater}
          disabled={ctx.draft.saving}
        >
          Configure later
        </Button>
        <div className="ml-auto flex gap-2">
          {index > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => goTo(steps[index - 1])}
              disabled={ctx.draft.saving}
            >
              Back
            </Button>
          )}
          {step === "summary" ? (
            <Button
              type="button"
              onClick={() => void finish()}
              disabled={ctx.draft.saving || !ctx.writable}
            >
              {ctx.draft.saving && (
                <Loader2
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              )}
              {ctx.draft.saving ? "Saving…" : "Finish"}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={next}
              disabled={stepBlocker !== null || localErrors}
            >
              {step === "tavily" && !edits.tavily_api_key ? "Skip" : "Next"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function Summary({
  ctx,
  steps,
  onEdit,
}: {
  ctx: FieldContext;
  steps: WizardStep[];
  onEdit: (step: WizardStep) => void;
}) {
  const provider = currentProvider(ctx);
  const info = ctx.payload.providers[provider];
  const { edits } = ctx.draft;
  const secretText = (field: string) => {
    if (typeof edits[field] === "string") return "new key entered";
    if (field in edits) return "will be removed";
    const shadow = shadowOf(ctx, field);
    if (shadow) return `set by ${sourceNote(shadow)}`;
    const saved = ctx.payload.settings[field];
    if (isMaskedSecret(saved) && saved.set) {
      return `saved (${saved.hint ?? "set"})`;
    }
    return "not set";
  };
  const rows: Array<[WizardStep, string, string]> = [
    ["provider", "Provider", info?.label ?? provider],
    ["model", "Model", currentText(ctx.payload, edits, "model") || "not set"],
  ];
  if (info?.base_url_field) {
    rows.push([
      "key",
      fieldLabel(info.base_url_field, ctx.payload.providers),
      currentText(ctx.payload, edits, info.base_url_field) || "default",
    ]);
  }
  if (info?.key_field) {
    rows.push([
      "key",
      fieldLabel(info.key_field, ctx.payload.providers),
      secretText(info.key_field),
    ]);
  }
  rows.push(
    ["tavily", "Tavily API key", secretText("tavily_api_key")],
    [
      "folder",
      "Default folder",
      currentText(ctx.payload, edits, "default_workdir") || "not set",
    ],
    [
      "folder",
      "Mainland China mirrors",
      currentText(ctx.payload, edits, "mirror") === "cn" ? "on" : "off",
    ]
  );
  return (
    <dl className="divide-y divide-border rounded-md border border-border text-sm">
      {rows.map(([step, label, value]) => (
        <div
          key={label}
          className="flex items-center gap-3 px-3 py-2"
        >
          <dt className="w-40 shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 flex-1 truncate">{value}</dd>
          {steps.includes(step) && (
            <button
              type="button"
              onClick={() => onEdit(step)}
              className="shrink-0 rounded px-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Change ${label}`}
            >
              Change
            </button>
          )}
        </div>
      ))}
    </dl>
  );
}
