import { clearSubAgentStepsCache } from "@/lib/subAgentStepsStore";
import { clearWorkflowCache } from "@/lib/workflowStore";

export interface DeploymentConfig {
  deploymentUrl: string;
  langsmithApiKey?: string;
}

const CONFIG_KEY = "evoscientist-config";

// A config the browser wouldn't keep: every reader gets it until the page is
// reloaded, so none of them talks to the stored deployment instead.
let unsavedConfig: DeploymentConfig | null = null;

export function getConfig(): DeploymentConfig | null {
  if (typeof window === "undefined") return null;
  if (unsavedConfig) return unsavedConfig;

  let stored: string | null;
  try {
    stored = localStorage.getItem(CONFIG_KEY);
  } catch {
    return null;
  }
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored) as Partial<DeploymentConfig>;
    // A stored config with no usable deployment URL would make the SDK send
    // requests to the app's own origin (404s). Treat it as unconfigured so
    // the config dialog reappears instead.
    if (!parsed.deploymentUrl?.trim()) return null;
    // Older versions also stored a fixed assistantId; the assistant now comes
    // from the backend's folder, so it is dropped.
    return {
      deploymentUrl: parsed.deploymentUrl,
      langsmithApiKey: parsed.langsmithApiKey,
    };
  } catch {
    return null;
  }
}

function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  // Older Firefox names it NS_ERROR_DOM_QUOTA_REACHED.
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function store(value: string): boolean {
  try {
    localStorage.setItem(CONFIG_KEY, value);
    return true;
  } catch (error) {
    if (!isQuotaError(error)) return false;
  }
  // Settings matter more than the trace caches, which can make room.
  clearSubAgentStepsCache();
  clearWorkflowCache();
  try {
    localStorage.setItem(CONFIG_KEY, value);
    return true;
  } catch {
    return false;
  }
}

/** Stores the config; false when the browser wouldn't keep it, in which case
 *  `getConfig` returns it until the page is reloaded. */
export function saveConfig(config: DeploymentConfig): boolean {
  if (typeof window === "undefined") return true;
  const saved = store(JSON.stringify(config));
  unsavedConfig = saved ? null : config;
  return saved;
}
