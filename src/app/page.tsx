"use client";

import React, { useState, useEffect, useCallback, Suspense } from "react";
import Image from "next/image";
import { useQueryState } from "nuqs";
import { getConfig, saveConfig, DeploymentConfig } from "@/lib/config";
import { ConfigDialog } from "@/app/components/ConfigDialog";
import { Button } from "@/components/ui/button";
import { Assistant } from "@langchain/langgraph-sdk";
import { ClientProvider, useClient } from "@/providers/ClientProvider";
import {
  Settings,
  SquarePen,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
} from "lucide-react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ThreadList } from "@/app/components/ThreadList";
import { ChatProvider } from "@/providers/ChatProvider";
import { ChatInterface } from "@/app/components/ChatInterface";
import { SkillsMarketplace } from "@/app/components/SkillsMarketplace";
import { MemoryPanel } from "@/app/components/MemoryPanel";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { BetaBadge } from "@/app/components/BetaBadge";
import { HealthIndicator } from "@/app/components/HealthIndicator";
import { InspectorPanel } from "@/app/components/InspectorPanel";
import { setThreadAutoApprove } from "@/lib/autoApprove";

interface HomePageInnerProps {
  config: DeploymentConfig;
  configDialogOpen: boolean;
  setConfigDialogOpen: (open: boolean) => void;
  handleSaveConfig: (config: DeploymentConfig) => void;
}

function HomePageInner({
  config,
  configDialogOpen,
  setConfigDialogOpen,
  handleSaveConfig,
}: HomePageInnerProps) {
  const client = useClient();
  const [, setThreadId] = useQueryState("threadId");
  const [sidebar, setSidebar] = useQueryState("sidebar");
  const [view, setView] = useQueryState("view");
  const [inspector, setInspector] = useQueryState("inspector");

  const [mutateThreads, setMutateThreads] = useState<(() => void) | null>(null);
  const [interruptCount, setInterruptCount] = useState(0);
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [isDesktopLayout, setIsDesktopLayout] = useState<boolean | null>(null);
  const [chatSessionRevision, setChatSessionRevision] = useState(0);

  const fetchAssistant = useCallback(async () => {
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        config.assistantId
      );

    const resolve = async (): Promise<Assistant> => {
      // A UUID addresses one assistant directly; otherwise list the graph's
      // assistants and prefer the system default (fall back to the first).
      if (isUUID) {
        return await client.assistants.get(config.assistantId);
      }
      const assistants = await client.assistants.search({
        graphId: config.assistantId,
        limit: 100,
      });
      const found =
        assistants.find((a) => a.metadata?.["created_by"] === "system") ??
        assistants[0];
      if (!found) throw new Error("No assistant found for this graph.");
      return found;
    };

    // The langgraph backend may not be ready the instant the page mounts — the
    // request then fails with "Failed to fetch". Retry a few times so a transient
    // startup race self-heals instead of surfacing a scary console error.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        setAssistant(await resolve());
        return;
      } catch (error) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 700));
          continue;
        }
        console.warn(
          "Couldn't resolve the EvoScientist assistant; addressing the graph by id instead. Is the backend running?",
          error
        );
      }
    }

    // Fallback: address the graph directly by id (works on `langgraph dev`).
    setAssistant({
      assistant_id: config.assistantId,
      graph_id: config.assistantId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      config: {},
      metadata: {},
      version: 1,
      name: config.assistantId,
      context: {},
    });
  }, [client, config.assistantId]);

  useEffect(() => {
    fetchAssistant();
  }, [fetchAssistant]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 768px)");
    const updateLayout = () => setIsDesktopLayout(mediaQuery.matches);

    updateLayout();
    mediaQuery.addEventListener("change", updateLayout);
    return () => mediaQuery.removeEventListener("change", updateLayout);
  }, []);

  useEffect(() => {
    if (isDesktopLayout === false && sidebar && inspector) {
      setInspector(null);
    }
  }, [inspector, isDesktopLayout, setInspector, sidebar]);

  const closeSidebar = useCallback(() => setSidebar(null), [setSidebar]);
  const toggleSidebar = useCallback(() => {
    if (sidebar) {
      setSidebar(null);
      return;
    }
    if (isDesktopLayout === false) setInspector(null);
    setSidebar("1");
  }, [isDesktopLayout, setInspector, setSidebar, sidebar]);
  const toggleInspector = useCallback(() => {
    if (inspector) {
      setInspector(null);
      return;
    }
    if (isDesktopLayout === false) setSidebar(null);
    setInspector("1");
  }, [inspector, isDesktopLayout, setInspector, setSidebar]);
  const sidebarToggleLabel = view
    ? sidebar
      ? "Hide navigation"
      : "Show navigation"
    : sidebar
    ? "Hide research"
    : "Show research";
  const startNewChat = useCallback(() => {
    setThreadAutoApprove(null, false);
    setThreadId(null);
    setView(null);
    setChatSessionRevision((revision) => revision + 1);
  }, [setThreadId, setView]);
  const selectThread = useCallback(
    async (id: string) => {
      setThreadAutoApprove(null, false);
      setView(null);
      await setThreadId(id);
      setChatSessionRevision((revision) => revision + 1);
    },
    [setThreadId, setView]
  );

  return (
    <>
      <ConfigDialog
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
        onSave={handleSaveConfig}
        initialConfig={config}
      />
      <div className="flex h-screen flex-col">
        <header className="flex h-14 items-center justify-between gap-2 border-b border-border px-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Image
                src="/evoscientist-logo.png"
                alt="EvoScientist"
                width={28}
                height={28}
                className="size-6 shrink-0"
                priority
              />
              {/* Show the wordmark only when the thread sidebar is open (it
                  titles the panel). When collapsed, keep just the logo + the
                  toggle / new-chat icons for a compact header. */}
              {sidebar && (
                <>
                  <h1 className="truncate text-base font-semibold sm:text-lg">
                    EvoScientist
                  </h1>
                  <BetaBadge />
                </>
              )}
            </div>
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleSidebar}
                aria-label={sidebarToggleLabel}
                className="relative size-8"
              >
                {sidebar ? (
                  <PanelLeftClose
                    className="size-5"
                    aria-hidden="true"
                  />
                ) : (
                  <PanelLeft
                    className="size-5"
                    aria-hidden="true"
                  />
                )}
                {interruptCount > 0 && (
                  <span className="absolute right-0 top-0 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] text-destructive-foreground">
                    {interruptCount}
                  </span>
                )}
              </Button>
              {!sidebar && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={startNewChat}
                  aria-label="New chat"
                  className="size-8"
                >
                  <SquarePen
                    className="size-5"
                    aria-hidden="true"
                  />
                </Button>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <HealthIndicator
              deploymentUrl={config.deploymentUrl}
              onReconnect={(url) =>
                handleSaveConfig({ ...config, deploymentUrl: url })
              }
            />
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleInspector}
              aria-label={inspector ? "Hide workspace" : "Show workspace"}
              title={inspector ? "Hide workspace" : "Show workspace"}
              className="size-8"
            >
              {inspector ? (
                <PanelRightClose
                  className="size-5"
                  aria-hidden="true"
                />
              ) : (
                <PanelRight
                  className="size-5"
                  aria-hidden="true"
                />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setConfigDialogOpen(true)}
              aria-label="Settings"
              title="Settings"
              className="size-8"
            >
              <Settings
                className="size-5"
                aria-hidden="true"
              />
            </Button>
          </div>
        </header>

        <div className="relative flex-1 overflow-hidden">
          {sidebar && isDesktopLayout === false && (
            <div className="absolute inset-0 z-40 flex md:hidden">
              <button
                type="button"
                aria-label="Close research"
                className="absolute inset-0 bg-black/40"
                onClick={closeSidebar}
              />
              <aside
                aria-label={view ? "Navigation" : "Research navigation"}
                className="relative z-10 h-full w-[min(19rem,calc(100vw-2.25rem))] bg-background shadow-xl"
              >
                <ThreadList
                  onClose={closeSidebar}
                  onNewChat={startNewChat}
                  onThreadSelect={async (id) => {
                    await selectThread(id);
                    closeSidebar();
                  }}
                  onMutateReady={(fn) => setMutateThreads(() => fn)}
                  onInterruptCountChange={setInterruptCount}
                />
              </aside>
            </div>
          )}
          {inspector && isDesktopLayout === false && (
            <div className="absolute inset-0 z-40 flex justify-end md:hidden">
              <button
                type="button"
                aria-label="Close workspace"
                className="absolute inset-0 bg-black/40"
                onClick={() => setInspector(null)}
              />
              <aside
                aria-label="Workspace"
                className="relative z-10 h-full w-[min(22rem,calc(100vw-2.25rem))] bg-background shadow-xl"
              >
                <InspectorPanel onClose={() => setInspector(null)} />
              </aside>
            </div>
          )}
          <ResizablePanelGroup
            direction="horizontal"
            autoSaveId="evoscientist-chat"
          >
            {sidebar && isDesktopLayout && (
              <>
                <ResizablePanel
                  id="thread-history"
                  order={1}
                  defaultSize={23}
                  minSize={18}
                  className="relative min-w-[260px]"
                >
                  <ThreadList
                    onNewChat={startNewChat}
                    onThreadSelect={selectThread}
                    onMutateReady={(fn) => setMutateThreads(() => fn)}
                    onInterruptCountChange={setInterruptCount}
                  />
                </ResizablePanel>
                <ResizableHandle />
              </>
            )}

            <ResizablePanel
              id="chat"
              className="relative flex flex-col"
              order={2}
            >
              {view === "skills" ? (
                <SkillsMarketplace />
              ) : view === "memory" ? (
                <MemoryPanel />
              ) : (
                <ChatProvider
                  key={chatSessionRevision}
                  activeAssistant={assistant}
                  onHistoryRevalidate={() => mutateThreads?.()}
                >
                  <ChatInterface assistant={assistant} />
                </ChatProvider>
              )}
            </ResizablePanel>

            {inspector && isDesktopLayout && (
              <>
                <ResizableHandle />
                <ResizablePanel
                  id="inspector"
                  order={3}
                  defaultSize={26}
                  minSize={20}
                  className="relative min-w-[300px]"
                >
                  <InspectorPanel onClose={() => setInspector(null)} />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>
      </div>
    </>
  );
}

function HomePageContent() {
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [assistantId, setAssistantId] = useQueryState("assistantId");

  // On mount, check for saved config, otherwise show config dialog
  useEffect(() => {
    const savedConfig = getConfig();
    if (savedConfig) {
      setConfig(savedConfig);
      if (!assistantId) {
        setAssistantId(savedConfig.assistantId);
      }
    } else {
      setConfigDialogOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If config changes, update the assistantId
  useEffect(() => {
    if (config && !assistantId) {
      setAssistantId(config.assistantId);
    }
  }, [config, assistantId, setAssistantId]);

  const handleSaveConfig = useCallback((newConfig: DeploymentConfig) => {
    saveConfig(newConfig);
    setConfig(newConfig);
  }, []);

  const langsmithApiKey =
    config?.langsmithApiKey || process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "";

  if (!config) {
    return (
      <>
        <ConfigDialog
          open={configDialogOpen}
          onOpenChange={setConfigDialogOpen}
          onSave={handleSaveConfig}
        />
        <div className="flex h-screen items-center justify-center">
          <div className="text-center">
            <h1 className="text-2xl font-bold">Welcome to EvoScientist</h1>
            <p className="mt-2 text-muted-foreground">
              Configure your deployment to get started
            </p>
            <Button
              onClick={() => setConfigDialogOpen(true)}
              className="mt-4"
            >
              Open Configuration
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <ClientProvider
      deploymentUrl={config.deploymentUrl}
      apiKey={langsmithApiKey}
    >
      <HomePageInner
        config={config}
        configDialogOpen={configDialogOpen}
        setConfigDialogOpen={setConfigDialogOpen}
        handleSaveConfig={handleSaveConfig}
      />
    </ClientProvider>
  );
}

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <p className="text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <HomePageContent />
    </Suspense>
  );
}
