"use client";

// The Settings page (`view=settings`, the header gear) and its first-run
// entry (`view=setup`). Two groups: General, EvoScientist's provider, model,
// keys, search, workspace and mirrors, read from the deployment's
// GET /api/settings and saved through this WebUI's PATCH /api/settings relay
// (config.yaml, applies after a restart); and This browser, the deployment URL
// and chat display (BrowserSettings, applies at once). On a first run
// `view=setup` shows the General fields as a wizard (SetupWizard) instead.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Plug,
  RotateCw,
  Settings,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrowserSettings } from "@/app/components/BrowserSettings";
import { SettingsCard } from "@/app/components/SettingsCard";
import {
  useAvailableModels,
  type ModelRegistryEntry,
} from "@/app/hooks/useAvailableModels";
import { useSettings, useSettingsAccess } from "@/app/hooks/useSettings";
import { useSettingsDraft } from "@/app/hooks/useSettingsDraft";
import { useWideEnough } from "@/app/hooks/useWideEnough";
import {
  MirrorField,
  ModelField,
  ProviderAccessFields,
  ProviderField,
  SecretField,
  TextField,
  UnplacedErrors,
} from "@/app/components/SetupFields";
import {
  currentProvider,
  type FieldContext,
} from "@/app/components/setupFieldContext";
import { SetupWizard } from "@/app/components/SetupWizard";
import { desktopBridge } from "@/lib/desktop";
import { isSetupDeferred } from "@/lib/setupDeferral";
import { fieldLabel, readOnlyReason } from "@/lib/settingsForm";
import type { SettingsPayload } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useDeployment } from "@/providers/ClientProvider";

const noticeClass =
  "flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100";

interface SetupViewProps {
  /** `settings` (the header gear) always shows the form. `setup` (the
   *  first-run gate, the chat notice, the desktop app's `?view=setup`) shows
   *  the wizard on a first run the user has not put off. */
  entry: "settings" | "setup";
  /** Back to the chat ("Configure later", Close, or done). */
  onClose: () => void;
  /** Connect this page to another deployment URL (validated, trimmed). */
  onSaveDeploymentUrl: (url: string) => void;
  /** The `setup` entry shows the form now (not the wizard): the page moves to
   *  `view=settings`, so the pressed gear closes it on the first click. */
  onFormShown?: () => void;
}

const SECTIONS = [
  {
    group: "General",
    items: [
      ["settings-model", "Model"],
      ["settings-search", "Search"],
      ["settings-workspace", "Workspace"],
      ["settings-mirrors", "Mirrors"],
    ],
  },
  {
    group: "This browser",
    items: [
      ["settings-connection", "Connection"],
      ["settings-display", "Display"],
    ],
  },
] as const;

const ALL_SECTION_IDS: readonly string[] = SECTIONS.flatMap(({ items }) =>
  items.map(([id]) => id)
);
const BROWSER_SECTION_IDS: readonly string[] = [
  "settings-connection",
  "settings-display",
];

/** Scroll a section into view (jsdom has no `scrollIntoView`). */
function showSection(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ block: "start" });
}

const headerButtonClass =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:size-11";

export function SetupView({
  entry,
  onClose,
  onSaveDeploymentUrl,
  onFormShown,
}: SetupViewProps) {
  const { deploymentUrl } = useDeployment();
  const settings = useSettings();
  const { access, refresh } = useSettingsAccess();
  const { registry } = useAvailableModels();
  const draft = useSettingsDraft(settings.payload, refresh);
  const [mode, setMode] = useState<"wizard" | "form" | null>(null);
  const payload = settings.payload;
  const decidable = !!payload && access !== undefined;
  const firstRun =
    !!payload &&
    access !== undefined &&
    payload.setup_needed &&
    !payload.config_error &&
    access.writable &&
    !isSetupDeferred(deploymentUrl);

  // Decided once, when both answers are in: the wizard for a first run the
  // user has not put off, the form otherwise. The gear's entry is always the
  // form, also when it opens over the wizard.
  useEffect(() => {
    if (entry === "settings") {
      if (mode !== "form") setMode("form");
      return;
    }
    if (mode !== null || !decidable) return;
    setMode(firstRun ? "wizard" : "form");
  }, [entry, mode, decidable, firstRun]);

  const unreadable = !!settings.error && !payload;
  // The wizard's own screen, also while the first answers are on their way,
  // so a first run does not flash the form before it.
  const wizardScreen =
    entry === "setup" &&
    !settings.unsupported &&
    !unreadable &&
    (mode === "wizard" || (mode === null && (!decidable || firstRun)));

  // Only once the form is decided (or the deployment has no settings API): a
  // failed first read (EvoSci still starting) may still turn into a first run.
  const formDecided = mode === "form" || settings.unsupported;
  useEffect(() => {
    if (entry === "setup" && !wizardScreen && formDecided) onFormShown?.();
  }, [entry, wizardScreen, formDecided, onFormShown]);

  // The section index: the General sections exist only with the form.
  const formShown =
    !settings.unsupported && !unreadable && !!payload && access !== undefined;
  const presentSections = formShown ? ALL_SECTION_IDS : BROWSER_SECTION_IDS;
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const { active, choose } = useActiveSection(scrollRoot, presentSections);
  const roomForIndex = useWideEnough(scrollRoot, INDEX_MIN_WIDTH);

  const reload = (
    <button
      type="button"
      onClick={() => void refresh()}
      className={headerButtonClass}
      title="Reload"
      aria-label="Reload"
    >
      <RotateCw
        className="size-4"
        aria-hidden="true"
      />
    </button>
  );
  const loading = (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2
        className="size-4 animate-spin"
        aria-hidden="true"
      />
      Loading…
    </div>
  );

  if (wizardScreen) {
    let body: React.ReactNode = loading;
    if (payload && access !== undefined) {
      const ctx: FieldContext = { payload, draft, writable: access.writable };
      body = (
        <div className="space-y-4">
          <RestartNotice
            // A new set of waiting fields starts the notice afresh, so an
            // earlier "restarting" answer does not hide Restart now.
            key={payload.restart_fields.join(",")}
            payload={payload}
            onRestarted={refresh}
          />
          <SetupWizard
            ctx={ctx}
            registry={registry.entries}
            defaultFolder={desktopBridge()?.defaultFolder}
            onConfigureLater={onClose}
            onFinished={() => setMode("form")}
          />
        </div>
      );
    }
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-4 py-5 sm:px-5 sm:py-6">
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
                The model EvoScientist uses, its keys, search, workspace and
                mirrors. Saved in EvoScientist&apos;s config.yaml, the same file
                EvoSci onboard writes.
              </p>
            </div>
            {reload}
          </header>
          {body}
        </div>
      </div>
    );
  }

  let evoBody: React.ReactNode;
  if (settings.unsupported) {
    evoBody = (
      <SettingsCard>
        <p className="text-sm text-muted-foreground">
          This EvoScientist version has no settings API. Use EvoSci onboard in a
          terminal.
        </p>
      </SettingsCard>
    );
  } else if (unreadable) {
    evoBody = (
      <SettingsCard>
        <div className="space-y-2">
          <p className="text-sm text-destructive">
            The settings could not be read from {deploymentUrl}.
          </p>
          <button
            type="button"
            onClick={() => {
              showSection("settings-connection");
              document.getElementById("settings-deployment-url")?.focus();
            }}
            className="rounded text-sm font-medium text-[var(--brand)] underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Check the address under Connection
          </button>
        </div>
      </SettingsCard>
    );
  } else if (!payload || access === undefined) {
    // A failed re-read (EvoSci restarting) keeps the form and its draft.
    evoBody = <SettingsCard>{loading}</SettingsCard>;
  } else {
    const ctx: FieldContext = { payload, draft, writable: access.writable };
    const reason = readOnlyReason(access);
    evoBody = (
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
          // A new set of waiting fields starts the notice afresh, so an
          // earlier "restarting" answer does not hide Restart now.
          key={payload.restart_fields.join(",")}
          payload={payload}
          onRestarted={refresh}
        />
        <SetupForm
          ctx={ctx}
          registry={registry.entries}
        />
      </div>
    );
  }

  return (
    <div
      ref={setScrollRoot}
      className="h-full overflow-y-auto"
    >
      <div className="mx-auto max-w-[960px] px-4 py-5 sm:px-5 sm:py-6">
        <header className="mb-6 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-xl font-semibold sm:text-2xl">
              <Settings
                className="size-5"
                aria-hidden="true"
              />
              Settings
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              EvoScientist&apos;s model, search, workspace and mirrors, and how
              this page connects and shows the chat.
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            {reload}
            <button
              type="button"
              onClick={onClose}
              className={headerButtonClass}
              title="Close settings"
              aria-label="Close settings"
            >
              <X
                className="size-4"
                aria-hidden="true"
              />
            </button>
          </div>
        </header>
        <div className="flex gap-10">
          {roomForIndex !== false && (
            <SectionIndex
              active={active}
              present={presentSections}
              onChoose={(id) => {
                choose(id);
                const target = document.getElementById(id);
                const still = window.matchMedia?.(
                  "(prefers-reduced-motion: reduce)"
                ).matches;
                target?.scrollIntoView?.({
                  block: "start",
                  behavior: still ? "auto" : "smooth",
                });
                target?.focus({ preventScroll: true });
              }}
            />
          )}
          <div className="min-w-0 max-w-[720px] flex-1 space-y-8">
            <SettingsGroup
              id="settings-general"
              title="General"
              tag="config.yaml · applies after a restart"
            >
              {evoBody}
            </SettingsGroup>
            <SettingsGroup
              id="settings-this-browser"
              title="This browser"
              tag="applies at once"
            >
              <BrowserSettings
                deploymentUrl={deploymentUrl}
                onSaveDeploymentUrl={onSaveDeploymentUrl}
                hasUnsavedEdits={Object.keys(draft.edits).length > 0}
                saving={draft.saving}
              />
            </SettingsGroup>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Which section the page shows: the first present one in the top part of the
 * scroll area, the last one once scrolled to the bottom (a short last section
 * never reaches the top), and a chosen one right away while its scroll runs.
 */
function useActiveSection(
  root: HTMLElement | null,
  present: readonly string[]
) {
  const [current, setCurrent] = useState<string | null>(null);
  const pinnedUntil = useRef(0);
  const presentKey = present.join(" ");
  useEffect(() => {
    if (!root) return;
    const ids = presentKey.split(" ");
    const visible = new Set<string>();
    const settle = () => {
      if (performance.now() < pinnedUntil.current) return;
      const atBottom =
        root.scrollTop > 0 &&
        root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
      const next = atBottom
        ? ids[ids.length - 1]
        : ids.find((id) => visible.has(id));
      if (next) setCurrent(next);
    };
    root.addEventListener("scroll", settle, { passive: true });
    // The user scrolling on their own ends a click's pin.
    const unpin = () => {
      pinnedUntil.current = 0;
    };
    const userInput = ["wheel", "touchmove", "keydown"] as const;
    for (const type of userInput) {
      root.addEventListener(type, unpin, { passive: true });
    }
    // jsdom has no IntersectionObserver.
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (entry.isIntersecting) visible.add(entry.target.id);
                else visible.delete(entry.target.id);
              }
              settle();
            },
            { root, rootMargin: "0px 0px -55% 0px" }
          );
    for (const id of ids) {
      const section = document.getElementById(id);
      if (section) observer?.observe(section);
    }
    return () => {
      root.removeEventListener("scroll", settle);
      for (const type of userInput) root.removeEventListener(type, unpin);
      observer?.disconnect();
    };
  }, [root, presentKey]);
  const choose = useCallback((id: string) => {
    pinnedUntil.current = performance.now() + 800;
    setCurrent(id);
  }, []);
  const active =
    current !== null && present.includes(current)
      ? current
      : present[0] ?? null;
  return { active, choose };
}

// The page's own width decides the section index, not the window's: with the
// sidebar and the inspector docked, a 1024 px window leaves the page about
// 460 px, and the index (9rem and its 2.5rem gap) squeezed the form to about
// 230 px. From 720 px the form keeps about 500 px beside it.
const INDEX_MIN_WIDTH = 720;

/** The wide layout's table of contents: a rail with the current section on it. */
function SectionIndex({
  active,
  present,
  onChoose,
}: {
  active: string | null;
  present: readonly string[];
  onChoose: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-6 hidden w-36 shrink-0 self-start md:block"
    >
      {SECTIONS.map(({ group, items }) => (
        <div
          key={group}
          className="mb-6 last:mb-0"
        >
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {group}
          </p>
          <ul className="m-0 list-none border-l border-border p-0">
            {items.map(([id, label]) => {
              const current = active === id;
              const available = present.includes(id);
              return (
                <li
                  key={id}
                  className="m-0"
                >
                  <button
                    type="button"
                    onClick={() => onChoose(id)}
                    disabled={!available}
                    aria-current={current ? "location" : undefined}
                    className={cn(
                      "-ml-px block w-full rounded-r-md border-0 border-l-2 border-solid py-1.5 pl-3 pr-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
                      current
                        ? "border-[var(--brand)] font-medium text-foreground"
                        : "border-transparent text-muted-foreground enabled:hover:border-border enabled:hover:text-foreground",
                      !available && "opacity-50"
                    )}
                  >
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** One of the page's two groups: its heading and tag (when changes apply)
 *  above the cards of its sections. */
function SettingsGroup({
  id,
  title,
  tag,
  children,
}: {
  id: string;
  title: string;
  tag: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3
          id={id}
          className="text-base font-semibold"
        >
          {title}
        </h3>
        <span className="rounded-full bg-accent px-2 py-0.5 text-xs text-muted-foreground">
          {tag}
        </span>
      </div>
      {children}
    </section>
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

/** How to restart a backend the desktop app doesn't own: EvoSci reuses a
 *  running backend, which lasts across sessions until it is stopped. */
const APPLY_BY_SERVER_STOP =
  "Apply them with EvoSci server stop, then start EvoSci again. Stopping it ends running work in every project that uses this backend.";

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
        text: `The app did not start this EvoScientist. ${APPLY_BY_SERVER_STOP}`,
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
          {!bridge?.restartBackend && ` ${APPLY_BY_SERVER_STOP}`}
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
  const blocked = draft.blocked;
  const formFields = new Set(
    [
      "provider",
      "model",
      info?.key_field,
      info?.base_url_field,
      "tavily_api_key",
      "default_workdir",
      "mirror",
    ].filter((f): f is string => !!f)
  );
  const [saved, setSaved] = useState(false);

  const save = async () => {
    const outcome = await draft.save();
    setSaved(outcome.ok);
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <SettingsCard>
        <fieldset
          id="settings-model"
          tabIndex={-1}
          className="scroll-mt-9 space-y-4 focus:outline-none"
        >
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
      </SettingsCard>
      <SettingsCard>
        <fieldset
          id="settings-search"
          tabIndex={-1}
          className="scroll-mt-9 space-y-4 focus:outline-none"
        >
          <legend className="mb-2 text-sm font-semibold">Search</legend>
          <SecretField
            ctx={ctx}
            field="tavily_api_key"
            check={{ provider: "tavily", baseUrlField: null }}
          />
        </fieldset>
      </SettingsCard>
      {/* Workspace: named like the inspector's Workspace tab. The mirrors are
          about where setup and updates download from, so they stand apart. */}
      <SettingsCard>
        <fieldset
          id="settings-workspace"
          tabIndex={-1}
          className="scroll-mt-9 space-y-4 focus:outline-none"
        >
          <legend className="mb-2 text-sm font-semibold">Workspace</legend>
          <TextField
            ctx={ctx}
            field="default_workdir"
            description="Where EvoScientist keeps its work. Leave empty for the folder it starts in."
          />
        </fieldset>
      </SettingsCard>
      <SettingsCard>
        <fieldset
          id="settings-mirrors"
          tabIndex={-1}
          className="scroll-mt-9 space-y-4 focus:outline-none"
        >
          <legend className="mb-2 text-sm font-semibold">Mirrors</legend>
          <MirrorField ctx={ctx} />
        </fieldset>
      </SettingsCard>

      {draft.message && (
        <p
          role="alert"
          className="text-sm text-destructive"
        >
          {draft.message}
        </p>
      )}
      <UnplacedErrors
        ctx={ctx}
        shown={(field) => formFields.has(field)}
      />
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
