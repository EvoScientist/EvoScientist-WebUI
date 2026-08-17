export interface DeploymentConfig {
  deploymentUrl: string;
  assistantId: string;
  langsmithApiKey?: string;
}

// The UI always talks to the EvoScientist main agent. writing-agent and
// data-analysis-agent are internal sub-agents and are intentionally not
// user-selectable, so the assistant is fixed rather than configurable.
export const DEFAULT_ASSISTANT_ID = "EvoScientist";

const CONFIG_KEY = "evoscientist-config";

export function isLoopbackDeployment(deploymentUrl: string): boolean {
  try {
    const hostname = new URL(deploymentUrl).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

export function getConfig(): DeploymentConfig | null {
  if (typeof window === "undefined") return null;

  const stored = localStorage.getItem(CONFIG_KEY);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored) as DeploymentConfig;
    // A stored config with no usable deployment URL would make the SDK send
    // requests to the app's own origin (404s). Treat it as unconfigured so
    // the config dialog reappears instead.
    if (!parsed.deploymentUrl?.trim()) return null;
    // Older WebUI releases could persist a LangSmith key in this object. A
    // stale value makes the SDK send X-Api-Key to local LangGraph dev, which
    // rejects the request with `UnauthorizedResponseError: User not found`.
    // Local deployments do not need LangSmith authentication, so discard the
    // legacy field while preserving it for authenticated remote deployments.
    return {
      deploymentUrl: parsed.deploymentUrl,
      assistantId: DEFAULT_ASSISTANT_ID,
      ...(!isLoopbackDeployment(parsed.deploymentUrl) && parsed.langsmithApiKey
        ? { langsmithApiKey: parsed.langsmithApiKey }
        : {}),
    };
  } catch {
    return null;
  }
}

export function saveConfig(config: DeploymentConfig): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}
