// The rules of the Setup view and wizard that do not need React: what a field
// shows, what a save sends, the wizard's step order, and the wording of the
// backend's answers (EvoScientist's /api/settings, WebUI#55).

import type {
  ProviderInfo,
  RelayRefusal,
  SettingSource,
  SettingsPayload,
  SettingsWriteAccess,
} from "@/lib/settings";

/** Unsaved changes, by field: a string is the new value, `null` removes the
 *  field (a secret, or a value going back to its default). A field that is
 *  not here is unchanged. */
export type Edits = Readonly<Record<string, string | null>>;

/** A secret as GET shows it: never the value, at most its last characters. */
export interface MaskedSecret {
  set: boolean;
  hint?: string;
}

export function isMaskedSecret(value: unknown): value is MaskedSecret {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { set?: unknown }).set === "boolean"
  );
}

/** A plain field's saved value as text ("" when unset or not text). */
export function savedText(payload: SettingsPayload, field: string): string {
  const value = payload.settings[field];
  return typeof value === "string" ? value : "";
}

/** A plain field's value with the unsaved change applied. */
export function currentText(
  payload: SettingsPayload,
  edits: Edits,
  field: string
): string {
  if (field in edits) return edits[field] ?? "";
  return savedText(payload, field);
}

/**
 * Record a change. A secret's empty field keeps the stored value (so it is
 * no change); `null` removes it. A plain field typed back to its saved value
 * is no change either, and an emptied one goes back to its default (`null`).
 */
export function applyEdit(
  edits: Edits,
  payload: SettingsPayload,
  field: string,
  value: string | null,
  { secret }: { secret: boolean }
): Edits {
  const next: Record<string, string | null> = { ...edits };
  if (secret) {
    if (value === "") delete next[field];
    else next[field] = value;
    return next;
  }
  const saved = savedText(payload, field);
  if ((value ?? "") === saved) delete next[field];
  else next[field] = value === "" ? null : value;
  return next;
}

/**
 * The changes a save sends: a key or base URL typed for a provider other
 * than the selected one stays in the form but is not sent. Sent, it would be
 * checked online and could refuse the whole save over a field the page no
 * longer shows. A field two providers share (DashScope and its coding plan)
 * counts as the selected provider's.
 */
export function sendableEdits(
  edits: Edits,
  providers: Record<string, ProviderInfo>,
  provider: string
): Edits {
  const own = new Set(
    [
      providers[provider]?.key_field,
      providers[provider]?.base_url_field,
    ].filter((f): f is string => !!f)
  );
  const providerFields = new Set(
    Object.values(providers).flatMap((p) =>
      [p.key_field, p.base_url_field].filter((f): f is string => !!f)
    )
  );
  return Object.fromEntries(
    Object.entries(edits).filter(
      ([field]) => own.has(field) || !providerFields.has(field)
    )
  );
}

/**
 * The model to offer when the provider changes, as EvoSci onboard picks it:
 * the first of `candidates` (the current model, then the saved one) that the
 * new provider lists, else the provider's first listed model. For a provider
 * whose check lists its models (Ollama, the custom endpoints) none, so the
 * user picks one of those or types one.
 */
export function modelForProvider(
  candidates: ReadonlyArray<string>,
  info: ProviderInfo | undefined,
  listed: ReadonlyArray<string>
): string {
  const kept = candidates.find((model) => listed.includes(model));
  if (kept) return kept;
  if (info?.lists_models) return "";
  return listed[0] ?? "";
}

/** The PATCH body: only the changed fields, and the revision the page read. */
export function patchBody(
  edits: Edits,
  revision: string | null
): Record<string, unknown> {
  return { ...edits, revision };
}

// GET shows a URL's user and password as `***` (`http://***@host`).
const HIDDEN_USERINFO = /:\/\/[^/?#]*\*\*\*@/;

/** Errors the page finds before sending: a URL whose hidden user and
 *  password were kept while the rest changed would save `***` as the
 *  password. Sent unchanged, the backend keeps the stored URL. */
export function draftErrors(edits: Edits): Record<string, string> {
  const errors: Record<string, string> = {};
  // A removed model falls back to the Anthropic default whatever the
  // provider is.
  if ("model" in edits && edits.model === null) {
    errors.model = "Choose or type a model.";
  }
  for (const [field, value] of Object.entries(edits)) {
    if (typeof value === "string" && HIDDEN_USERINFO.test(value)) {
      errors[field] =
        "Type the whole URL again, with its user name and password: the saved ones are hidden.";
    }
  }
  return errors;
}

/**
 * A changed base URL of a provider whose key is saved in config.yaml needs
 * that key in the same save (a new one, or removed), so the saved key never
 * goes to the new address; EvoScientist refuses the save otherwise.
 */
export function keyedBaseUrlErrors(
  edits: Edits,
  payload: SettingsPayload
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const info of Object.values(payload.providers)) {
    const { key_field: key, base_url_field: url } = info;
    if (!key || !url || !(url in edits) || key in edits) continue;
    const saved = payload.settings[key];
    if (isMaskedSecret(saved) && saved.set) {
      errors[key] =
        "Enter the API key again: the saved key is not sent to a new address.";
    }
  }
  return errors;
}

export type WizardStep =
  | "provider"
  | "key"
  | "model"
  | "tavily"
  | "folder"
  | "summary";

/** The wizard's steps. For a provider whose check lists models (Ollama, the
 *  custom endpoints), the key or base URL step comes first, so the model
 *  step can offer what the check found. */
export function wizardSteps(provider: ProviderInfo | undefined): WizardStep[] {
  const access: WizardStep[] =
    provider && (provider.key_field || provider.base_url_field) ? ["key"] : [];
  const middle: WizardStep[] = provider?.lists_models
    ? [...access, "model"]
    : ["model", ...access];
  return ["provider", ...middle, "tavily", "folder", "summary"];
}

/** The wizard step that holds a field, to show a save error where it is. */
export function stepOfField(
  field: string,
  provider: ProviderInfo | undefined
): WizardStep {
  if (field === "provider") return "provider";
  if (field === "model") return "model";
  if (field === "tavily_api_key") return "tavily";
  if (field === "default_workdir" || field === "mirror") return "folder";
  if (field === provider?.key_field || field === provider?.base_url_field) {
    return "key";
  }
  return "summary";
}

const FIELD_LABELS: Record<string, string> = {
  provider: "Provider",
  model: "Model",
  tavily_api_key: "Tavily API key",
  default_workdir: "Default folder",
  mirror: "Mainland China mirrors",
  // Not fields: what else a running backend reads at start.
  "mcp.yaml": "MCP servers (mcp.yaml)",
  subagents: "Built-in sub-agents",
  version: "EvoScientist version",
};

/** A readable name for a field, or for an entry of `restart_fields`. */
export function fieldLabel(
  field: string,
  providers: Record<string, ProviderInfo>
): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  for (const info of Object.values(providers)) {
    if (info.key_field === field) return `${info.label} API key`;
    if (info.base_url_field === field) return `${info.label} base URL`;
  }
  const words = field.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Where an override of a shadowed field comes from. */
export function sourceNote(source: SettingSource): string {
  switch (source.source) {
    case "env":
      return "an environment variable";
    case "cli":
      return "a flag of the running EvoSci";
    case "ccproxy":
      return "ccproxy";
    case "dotenv":
      return source.path ? `the .env file at ${source.path}` : "a .env file";
    default:
      return source.source;
  }
}

export type KeyStatus =
  | "valid"
  | "invalid"
  | "inconclusive"
  | "unavailable"
  | "empty";

/** The answer of POST /api/settings/test-key. `ok` is null when the check
 *  could not decide, so the page reads `status`. */
export interface KeyCheckResult {
  ok: boolean | null;
  status: KeyStatus;
  message: string;
  models?: string[];
}

const KEY_STATUS_TEXT: Record<KeyStatus, string> = {
  valid: "The key works.",
  invalid: "The key was refused.",
  inconclusive: "The key could not be checked; you can still save it.",
  unavailable: "There is no check for this key; you can still save it.",
  empty: "There is no key to check.",
};

// A provider without a key (Ollama) checks only that its server answers.
const CONNECTION_STATUS_TEXT: Record<KeyStatus, string> = {
  valid: "The server answers.",
  invalid: "The server refused the connection.",
  inconclusive: "The server could not be reached; you can still save.",
  unavailable: "There is no check for this server; you can still save.",
  empty: "There is nothing to check.",
};

/** The words for a check's `status`, for a key or a keyless server. */
export function keyStatusText(status: KeyStatus, keyless: boolean): string {
  return (keyless ? CONNECTION_STATUS_TEXT : KEY_STATUS_TEXT)[status];
}

const REFUSAL_TEXT: Record<RelayRefusal | "other_backend", string> = {
  not_loopback:
    "This WebUI server listens on the network, not on this machine only, so it does not save settings. Start it with EvoSci --ui webui, or with npm run dev:local.",
  host_not_loopback:
    "This page is open by a network address. Settings are saved from a page open at 127.0.0.1 or localhost on the machine that runs EvoScientist.",
  cross_origin: "This page is not on the WebUI's own address.",
  json_required: "The WebUI sent a request the backend does not take.",
  secret_missing:
    "The WebUI cannot read EvoScientist's local secret. Start EvoSci once so it creates it, and check that the WebUI and EvoScientist use the same data folder.",
  secret_rejected:
    "EvoScientist refused this machine's local secret: the WebUI and EvoScientist use different data folders.",
  backend_unreachable:
    "The WebUI server cannot reach EvoScientist on this machine.",
  backend_timeout: "EvoScientist did not answer in time.",
  unsupported: "This EvoScientist version cannot save settings from the WebUI.",
  other_backend:
    "The deployment URL is not the EvoScientist that runs next to this WebUI server, so the settings are changed on the machine that runs it.",
};

/** Why the page cannot save, in words. */
export function readOnlyReason(access: SettingsWriteAccess): string | null {
  return access.writable ? null : REFUSAL_TEXT[access.reason];
}

/** The text for an `{error: code}` answer of the settings routes. */
export function saveErrorText(body: unknown, status: number): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as {
    error?: unknown;
    path?: unknown;
    detail?: unknown;
  };
  const code = typeof b.error === "string" ? b.error : "";
  switch (code) {
    case "revision_mismatch":
      return "The configuration changed elsewhere, for example in a terminal. Fields you did not change now show the saved values; save again to apply your changes.";
    case "config_locked":
      return "EvoSci onboard is running in a terminal and holds the configuration. Your changes are kept; save again when it is done.";
    case "config_unreadable":
      return `config.yaml cannot be read${
        typeof b.path === "string" ? ` (${b.path})` : ""
      }${
        typeof b.detail === "string" ? `: ${b.detail}` : ""
      }. Fix the file, then save again.`;
    case "local_secret_required":
      // The backend's own refusal: it reads another secret than the relay.
      return REFUSAL_TEXT.secret_rejected;
    case "config_write_failed":
      return `config.yaml could not be written${
        typeof b.detail === "string" ? `: ${b.detail}` : ""
      }. Nothing was saved.`;
  }
  if (code in REFUSAL_TEXT) {
    return REFUSAL_TEXT[code as RelayRefusal];
  }
  return `Saving failed (HTTP ${status}).`;
}
