"use client";

// The Setup view (`view=setup`): EvoScientist's provider, model, keys, web
// search, folder and mirrors, read from the deployment's GET /api/settings and
// saved through this WebUI's PATCH /api/settings relay. On first run it shows
// the same fields as a wizard (SetupWizard). The header's gear ("Settings")
// stays the WebUI's own connection and display preferences.

import { useEffect, useState } from "react";
import { Loader2, Plug, RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useAvailableModels,
  type ModelRegistryEntry,
} from "@/app/hooks/useAvailableModels";
import { useSettings, useSettingsAccess } from "@/app/hooks/useSettings";
import { useSettingsDraft } from "@/app/hooks/useSettingsDraft";
import {
  MirrorField,
  ModelField,
  ProviderAccessFields,
  ProviderField,
  SecretField,
  TextField,
} from "@/app/components/SetupFields";
import {
  currentProvider,
  type FieldContext,
} from "@/app/components/setupFieldContext";
import { SetupWizard } from "@/app/components/SetupWizard";
import { desktopBridge } from "@/lib/desktop";
import { isSetupDeferred } from "@/lib/setupDeferral";
import { draftErrors, fieldLabel, readOnlyReason } from "@/lib/settingsForm";
import type { SettingsPayload } from "@/lib/settings";
import { useDeployment } from "@/providers/ClientProvider";

const noticeClass =
  "flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100";

interface SetupViewProps {
  /** Back to the chat ("Configure later", or done). */
  onClose: () => void;
}

export function SetupView({ onClose }: SetupViewProps) {
  const { deploymentUrl } = useDeployment();
  const settings = useSettings();
  const { access, refresh } = useSettingsAccess();
  const { registry } = useAvailableModels();
  const draft = useSettingsDraft(settings.payload, refresh);
  const [mode, setMode] = useState<"wizard" | "form" | null>(null);
  const payload = settings.payload;

  // Decided once, when both answers are in: the wizard for a first run the
  // user has not put off, the form otherwise.
  useEffect(() => {
    if (mode !== null || !payload || access === undefined) return;
    const firstRun =
      payload.setup_needed &&
      !payload.config_error &&
      access.writable &&
      !isSetupDeferred(deploymentUrl);
    setMode(firstRun ? "wizard" : "form");
  }, [mode, payload, access, deploymentUrl]);

  const header = (
    <header className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-2 text-xl font-semibold sm:text-2xl">
          <Plug
            className="size-5"
            aria-hidden="true"
          />
          Setup
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          The model EvoScientist uses, its keys, web search, folder and
          downloads. Saved in EvoScientist&apos;s config.yaml, the same file
          EvoSci onboard writes.
        </p>
      </div>
      <button
        type="button"
        onClick={() => void refresh()}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        title="Reload"
        aria-label="Reload"
      >
        <RotateCw
          className="size-4"
          aria-hidden="true"
        />
      </button>
    </header>
  );

  let body: React.ReactNode;
  if (settings.unsupported) {
    body = (
      <p className="text-sm text-muted-foreground">
        This EvoScientist version has no settings API. Use EvoSci onboard in a
        terminal.
      </p>
    );
  } else if (settings.error) {
    body = (
      <p className="text-sm text-destructive">
        The settings could not be read from {deploymentUrl}.
      </p>
    );
  } else if (!payload || access === undefined || mode === null) {
    body = (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2
          className="size-4 animate-spin"
          aria-hidden="true"
        />
        Loading…
      </div>
    );
  } else {
    const ctx: FieldContext = { payload, draft, writable: access.writable };
    const reason = readOnlyReason(access);
    body = (
      <div className="space-y-4">
        {reason && (
          <div
            role="status"
            className={noticeClass}
          >
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span>These settings are read-only here. {reason}</span>
          </div>
        )}
        {payload.config_error && <ConfigErrorNotice payload={payload} />}
        <RestartNotice
          payload={payload}
          onRestarted={refresh}
        />
        {mode === "wizard" ? (
          <SetupWizard
            ctx={ctx}
            registry={registry.entries}
            defaultFolder={desktopBridge()?.defaultFolder}
            onConfigureLater={onClose}
            onFinished={() => setMode("form")}
          />
        ) : (
          <SetupForm
            ctx={ctx}
            registry={registry.entries}
          />
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-4 py-5 sm:px-5 sm:py-6">
        {header}
        {body}
      </div>
    </div>
  );
}

function ConfigErrorNotice({ payload }: { payload: SettingsPayload }) {
  const error = payload.config_error;
  if (!error) return null;
  return (
    <div
      role="alert"
      className={noticeClass}
    >
      <TriangleAlert
        className="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span>
        config.yaml cannot be read ({error.path}): {error.detail}. EvoScientist
        runs on its defaults until the file is fixed.
      </span>
    </div>
  );
}

/** Which saved changes wait for a restart of EvoSci, and the way to do it. */
export function RestartNotice({
  payload,
  onRestarted,
}: {
  payload: SettingsPayload;
  onRestarted: () => Promise<unknown>;
}) {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string }
  >({ kind: "idle" });
  if (!payload.restart_required || payload.restart_fields.length === 0) {
    return null;
  }
  const bridge = desktopBridge();
  const names = payload.restart_fields
    .map((field) => fieldLabel(field, payload.providers))
    .join(", ");
  const restart = async () => {
    if (!bridge?.restartBackend) return;
    setState({ kind: "busy" });
    const result = await bridge.restartBackend().catch(() => ({
      ok: false as const,
      code: "failed",
    }));
    if (result.ok) {
      setState({ kind: "done", text: "EvoScientist is restarting." });
      await onRestarted();
    } else if (result.code === "not_owned") {
      setState({
        kind: "done",
        text: "The app did not start this EvoScientist. Restart EvoSci where it runs.",
      });
    } else {
      setState({
        kind: "done",
        text: `The restart failed (${result.code}).`,
      });
    }
  };
  return (
    <div
      role="status"
      className={noticeClass}
    >
      <RotateCw
        className="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <p>
          These changes take effect after EvoScientist restarts: {names}.
          {!bridge?.restartBackend && " Restart EvoSci to apply them."}
        </p>
        {bridge?.restartBackend && state.kind !== "done" && (
          <Button
            type="button"
            size="sm"
            onClick={() => void restart()}
            disabled={state.kind === "busy"}
          >
            Restart now
          </Button>
        )}
        {state.kind === "done" && <p>{state.text}</p>}
      </div>
    </div>
  );
}

function SetupForm({
  ctx,
  registry,
}: {
  ctx: FieldContext;
  registry: ReadonlyArray<ModelRegistryEntry>;
}) {
  const provider = currentProvider(ctx);
  const info = ctx.payload.providers[provider];
  const { draft } = ctx;
  const changed = Object.keys(draft.edits).length > 0;
  // The page's own checks block a save; the backend's errors show until
  // their field changes, and a save may try again.
  const blocked = Object.keys(draftErrors(draft.edits)).length > 0;
  const [saved, setSaved] = useState(false);

  const save = async () => {
    const outcome = await draft.save();
    setSaved(outcome.ok);
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold">Model</legend>
        <ProviderField ctx={ctx} />
        {info && (
          <ProviderAccessFields
            ctx={ctx}
            provider={provider}
            info={info}
          />
        )}
        <ModelField
          ctx={ctx}
          registry={registry}
        />
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold">Web search</legend>
        <SecretField
          ctx={ctx}
          field="tavily_api_key"
          check={{ provider: "tavily", baseUrlField: null }}
        />
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold">
          Folder and downloads
        </legend>
        <TextField
          ctx={ctx}
          field="default_workdir"
          description="Where EvoScientist keeps its work. Leave empty for the folder it starts in."
        />
        <MirrorField ctx={ctx} />
      </fieldset>

      {draft.message && (
        <p
          role="alert"
          className="text-sm text-destructive"
        >
          {draft.message}
        </p>
      )}
      {saved && !changed && !draft.message && (
        <p
          role="status"
          className="text-sm text-muted-foreground"
        >
          Saved.
        </p>
      )}
      {ctx.writable && (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={draft.discard}
            disabled={!changed || draft.saving}
          >
            Discard changes
          </Button>
          <Button
            type="submit"
            disabled={!changed || blocked || draft.saving}
          >
            {draft.saving && (
              <Loader2
                className="size-4 animate-spin"
                aria-hidden="true"
              />
            )}
            {draft.saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </form>
  );
}
