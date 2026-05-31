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

export function getConfig(): DeploymentConfig | null {
  if (typeof window === "undefined") return null;

  const stored = localStorage.getItem(CONFIG_KEY);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored) as DeploymentConfig;
    // Always pin the assistant to the EvoScientist main agent.
    return { ...parsed, assistantId: DEFAULT_ASSISTANT_ID };
  } catch {
    return null;
  }
}

export function saveConfig(config: DeploymentConfig): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}
