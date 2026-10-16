export interface DeploymentConfig {
  deploymentUrl: string;
  langsmithApiKey?: string;
}

const CONFIG_KEY = "evoscientist-config";

export function getConfig(): DeploymentConfig | null {
  if (typeof window === "undefined") return null;

  const stored = localStorage.getItem(CONFIG_KEY);
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

export function saveConfig(config: DeploymentConfig): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}
