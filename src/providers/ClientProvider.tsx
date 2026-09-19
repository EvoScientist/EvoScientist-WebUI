"use client";

import { createContext, useContext, useMemo, ReactNode } from "react";
import { Client } from "@langchain/langgraph-sdk";
import { makeClient } from "@/lib/streamMode";

interface ClientContextValue {
  client: Client;
  deploymentUrl: string;
  apiKey: string;
}

const ClientContext = createContext<ClientContextValue | null>(null);

interface ClientProviderProps {
  children: ReactNode;
  deploymentUrl: string;
  apiKey: string;
}

export function ClientProvider({
  children,
  deploymentUrl,
  apiKey,
}: ClientProviderProps) {
  const client = useMemo(() => {
    return makeClient({
      apiUrl: deploymentUrl,
      defaultHeaders: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
    });
  }, [deploymentUrl, apiKey]);

  const value = useMemo(
    () => ({ client, deploymentUrl, apiKey }),
    [client, deploymentUrl, apiKey]
  );

  return (
    <ClientContext.Provider value={value}>{children}</ClientContext.Provider>
  );
}

export function useClient(): Client {
  const context = useContext(ClientContext);

  if (!context) {
    throw new Error("useClient must be used within a ClientProvider");
  }
  return context.client;
}

/**
 * The deployment the SDK client is talking to right now. Anything that calls the
 * deployment's own routes outside the SDK must read it from here rather than
 * from stored config: reconnecting swaps the deployment without remounting the
 * chat, so a value read once would go on addressing the old one.
 */
export function useDeployment(): { deploymentUrl: string; apiKey: string } {
  const context = useContext(ClientContext);

  if (!context) {
    throw new Error("useDeployment must be used within a ClientProvider");
  }
  return { deploymentUrl: context.deploymentUrl, apiKey: context.apiKey };
}
