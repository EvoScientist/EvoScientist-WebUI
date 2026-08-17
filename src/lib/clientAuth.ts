import type { Client } from "@langchain/langgraph-sdk";

export function buildClientHeaders(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim();
  return {
    "Content-Type": "application/json",
    ...(trimmed ? { "X-Api-Key": trimmed } : {}),
  };
}

export function buildClientOptions(
  deploymentUrl: string,
  apiKey: string
): ConstructorParameters<typeof Client>[0] {
  return {
    apiUrl: deploymentUrl,
    // `undefined` makes the SDK auto-load LANGGRAPH/LANGSMITH/LANGCHAIN
    // credentials from the environment. The WebUI resolves its explicit
    // browser-safe key itself, so disable that hidden fallback.
    apiKey: null,
    defaultHeaders: buildClientHeaders(apiKey),
  };
}
