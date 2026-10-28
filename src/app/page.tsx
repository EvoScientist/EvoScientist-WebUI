"use client";

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  Suspense,
} from "react";
import Image from "next/image";
import { useQueryState } from "nuqs";
import { getConfig, saveConfig, DeploymentConfig } from "@/lib/config";
import { toast } from "sonner";
import { ConfigDialog } from "@/app/components/ConfigDialog";
import { Button } from "@/components/ui/button";
import { ClientProvider, useDeployment } from "@/providers/ClientProvider";
import { ProjectsProvider, useProjects } from "@/providers/ProjectsProvider";
import { findProject } from "@/lib/projects";
import { SetupNotice } from "@/app/components/SetupNotice";
import { SetupView } from "@/app/components/SetupView";
import { useSetupGate } from "@/app/hooks/useSetupGate";
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
import type { ThreadUnavailableInfo } from "@/app/hooks/useChat";
import { refreshModelRegistry } from "@/app/hooks/useAvailableModels";
import {
  refreshBackendLists,
  useBackendListsRefresh,
} from "@/app/hooks/useBackendListsRefresh";
import {
  ChatInterface,
  type ComposerFold,
  type ComposerSnapshot,
} from "@/app/components/ChatInterface";
import { ExpertsPanel } from "@/app/components/ExpertsPanel";
import { SkillsMarketplace } from "@/app/components/SkillsMarketplace";
import { MemoryPanel } from "@/app/components/MemoryPanel";
import { ScheduledTasksPanel } from "@/app/components/ScheduledTasksPanel";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { HealthIndicator } from "@/app/components/HealthIndicator";
import { InspectorPanel } from "@/app/components/InspectorPanel";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { FilePaneProvider } from "@/providers/FilePaneProvider";
import {
  FilePaneSizer,
  InspectorResizeHandle,
} from "@/app/components/FilePaneSizer";
import { setThreadAutoApprove } from "@/lib/autoApprove";
import type { MainChatReporter } from "@/lib/asyncAgents";
import type { NavTarget } from "@/lib/navTarget";
import { sameDeploymentUrl } from "@/lib/deploymentUrl";
import { cn } from "@/lib/utils";

interface HomePageInnerProps {
  config: DeploymentConfig;
  handleSaveConfig: (config: DeploymentConfig) => void;
}

function HomePageInner({ config, handleSaveConfig }: HomePageInnerProps) {
  const { deploymentUrl, apiKey } = useDeployment();
  // Panels that hold one backend's data start over on another.
  const backendKey = `${deploymentUrl}\n${apiKey}`;
  useBackendListsRefresh(deploymentUrl);
  const [threadId, setThreadId] = useQueryState("threadId");
  const [sidebar, setSidebar] = useQueryState("sidebar");
  const [view, setView] = useQueryState("view");
  const [memoryTab, setMemoryTab] = useQueryState("memoryTab");
  const [memoryObs, setMemoryObs] = useQueryState("memoryObs");
  const [memoryExec, setMemoryExec] = useQueryState("memoryExec");
  const [inspector, setInspector] = useQueryState("inspector");
  const [inspectorTab, setInspectorTab] = useQueryState("inspectorTab");
  // The gear's page; `setup` is its first-run entry (wizard or the same form).
  const settingsOpen = view === "settings" || view === "setup";
  // Settings' Connection: another address switches the backend and stays on
  // Settings, so the new backend shows the form, not a first run's wizard.
  // The switch remounts Settings, which takes the focused Save with it: the
  // new page's address field gets the focus.
  const focusUrlFieldRef = useRef(false);
  const saveDeploymentUrl = useCallback(
    (url: string) => {
      if (sameDeploymentUrl(url, config.deploymentUrl)) return;
      focusUrlFieldRef.current = true;
      handleSaveConfig({ ...config, deploymentUrl: url });
      void setView("settings");
    },
    [config, handleSaveConfig, setView]
  );
  useEffect(() => {
    if (!focusUrlFieldRef.current) return;
    focusUrlFieldRef.current = false;
    document.getElementById("settings-deployment-url")?.focus();
  }, [deploymentUrl]);

  useSetupGate(view, setView);

  const [mutateThreads, setMutateThreads] = useState<(() => void) | null>(null);
  const [interruptCount, setInterruptCount] = useState(0);
  const [isDesktopLayout, setIsDesktopLayout] = useState<boolean | null>(null);
  const [chatSessionRevision, setChatSessionRevision] = useState(0);
  // "Submit a message on the main thread" — registered by ChatInterface (only
  // while it's mounted, i.e. on the chat view), used by the Agents board to loop
  // an async result back to the main agent. Null when not on the chat view.
  const [notifyMainChat, setNotifyMainChat] = useState<MainChatReporter | null>(
    null
  );

  const {
    projects,
    refresh: refreshProjects,
    refreshing: projectsRefreshing,
    selectProject,
  } = useProjects();

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
  const closeInspector = useCallback(() => {
    setInspector(null);
    setInspectorTab(null);
  }, [setInspector, setInspectorTab]);
  const toggleSidebar = useCallback(() => {
    if (sidebar) {
      setSidebar(null);
      return;
    }
    if (isDesktopLayout === false) closeInspector();
    setSidebar("1");
  }, [closeInspector, isDesktopLayout, setSidebar, sidebar]);
  const toggleInspector = useCallback(() => {
    if (inspector) {
      closeInspector();
      return;
    }
    if (isDesktopLayout === false) setSidebar(null);
    setInspectorTab(null);
    setInspector("1");
  }, [
    closeInspector,
    inspector,
    isDesktopLayout,
    setInspector,
    setInspectorTab,
    setSidebar,
  ]);
  // The gear: Settings, or back to the chat from it. On a phone the sidebar
  // and the inspector cover the center column, so they close first.
  const settingsGearRef = useRef<HTMLButtonElement>(null);
  const toggleSettings = useCallback(() => {
    if (view === "settings") {
      void setView(null);
      return;
    }
    if (isDesktopLayout === false) {
      setSidebar(null);
      closeInspector();
    }
    void setView("settings");
  }, [closeInspector, isDesktopLayout, setSidebar, setView, view]);
  // Close / Configure later unmount the focused button: focus the gear.
  const closeSettings = useCallback(() => {
    void setView(null);
    settingsGearRef.current?.focus();
  }, [setView]);
  // Open the inspector straight on its Agents tab (composer pulse → board).
  const showAgentsInspector = useCallback(() => {
    setInspectorTab("agents");
    if (isDesktopLayout === false) setSidebar(null);
    setInspector("1");
  }, [isDesktopLayout, setInspector, setSidebar, setInspectorTab]);
  // A file opened anywhere shows in the inspector's Workspace tab.
  const revealFilePane = useCallback(() => {
    if (isDesktopLayout === false) setSidebar(null);
    setInspectorTab(null);
    setInspector("1");
  }, [isDesktopLayout, setInspector, setInspectorTab, setSidebar]);
  // The inspector is sized per what it shows (file tree vs. preview); the
  // sizer below drives it and its resize handle remembers the user's drags.
  const inspectorPanelRef = useRef<ImperativePanelHandle>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const threadPanelRef = useRef<ImperativePanelHandle>(null);
  const sidebarToggleLabel = view
    ? sidebar
      ? "Hide navigation"
      : "Show navigation"
    : sidebar
    ? "Hide research"
    : "Show research";
  // Unsent composer state carried over when the open thread vanished; read
  // once by the freshly mounted ChatInterface, cleared on any other
  // navigation so it can't leak into an unrelated conversation.
  const [composerSeed, setComposerSeed] = useState<ComposerSnapshot | null>(
    null
  );
  const composerSnapshotRef = useRef<
    ((unsent?: string | null) => ComposerFold) | null
  >(null);
  // Latest *intended* thread id, updated synchronously by the navigation
  // handlers below (the nuqs value lags by a render). The stale-thread
  // callback compares against this so a late 404 for a thread the user
  // already left can't be mistaken for the open one.
  const threadIdRef = useRef(threadId);
  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);
  // A new chat, in `project` when given (a registered project with its
  // folder), else in the current project.
  const startNewChat = useCallback(
    (project?: string) => {
      const chosen =
        typeof project === "string" ? findProject(projects, project) : null;
      if (chosen && !chosen.missing) {
        selectProject(chosen.key, { remember: true });
      }
      setThreadAutoApprove(null, false);
      threadIdRef.current = null;
      setThreadId(null);
      setView(null);
      setComposerSeed(null);
      setChatSessionRevision((revision) => revision + 1);
    },
    [setThreadId, setView, selectProject, projects]
  );
  // The backend reported the open thread (or its assistant) gone. Take the
  // same reset path as New Chat, carrying the unsent message plus whatever
  // was still in the composer/queue — but only if the report is about the
  // thread that is still open: a 404 can land late, after the user already
  // switched. Returns false to tell useChat the report was ignored.
  const handleThreadUnavailable = useCallback(
    ({
      threadId: staleId,
      unsentMessage,
    }: ThreadUnavailableInfo): false | { unsentBack: boolean } => {
      if (staleId !== threadIdRef.current) return false;
      // The composer folds the unsent message in: a /goal command is not
      // glued onto the rest (it is named as not sent instead).
      const fold = composerSnapshotRef.current?.(unsentMessage);
      const text = fold ? fold.text : unsentMessage?.trim() ?? "";
      const files = fold?.files ?? [];
      startNewChat();
      setComposerSeed(text || files.length > 0 ? { text, files } : null);
      return { unsentBack: fold ? fold.unsentBack : !!unsentMessage };
    },
    [startNewChat]
  );
  const handleDashboardNav = useCallback(
    (target: NavTarget) => {
      if (target.view === "memory") {
        setMemoryTab(target.tab);
        setMemoryObs(target.obsId ?? null);
        setMemoryExec(target.execId ?? null);
        setView("memory");
      } else if (target.view === "schedule") {
        setView("schedule");
      } else if (target.view === "experts") {
        setView("experts");
      } else if (target.view === "skills") {
        setView("skills");
      } else if (target.view === "setup") {
        setView("setup");
      } else if (target.view === "settings") {
        setView("settings");
      } else {
        if (inspector && inspectorTab !== "agents") {
          closeInspector();
          return;
        }
        if (isDesktopLayout === false) setSidebar(null);
        setInspectorTab(null);
        setInspector("1");
      }
    },
    [
      closeInspector,
      inspector,
      inspectorTab,
      isDesktopLayout,
      setInspector,
      setInspectorTab,
      setMemoryExec,
      setMemoryObs,
      setMemoryTab,
      setSidebar,
      setView,
    ]
  );
  const selectThread = useCallback(
    async (id: string) => {
      setThreadAutoApprove(null, false);
      setView(null);
      setComposerSeed(null);
      threadIdRef.current = id;
      const sameThread = threadId === id;
      // Bump revision before the awaited URL update: the remount tears down
      // the stale `useChat` instance before `threadId` flips, so its persist
      // effect can't write the previous thread's labels onto the target
      // thread. Only bump when the thread actually changes — clicking the
      // active row (e.g. returning from the Memory view) must not tear down
      // ChatInterface and re-fetch the full `/history`.
      if (!sameThread) {
        setChatSessionRevision((revision) => revision + 1);
      }
      await setThreadId(id);
    },
    [setThreadId, setView, threadId]
  );

  return (
    <>
      <div className="app-shell flex flex-col">
        <header className="mobile-app-header flex h-14 shrink-0 items-center justify-between gap-1 border-b border-border px-2 sm:gap-2 sm:px-4">
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
                <h1 className="hidden truncate text-base font-semibold sm:block sm:text-lg">
                  EvoScientist
                </h1>
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
                  onClick={() => startNewChat()}
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
              // Reconnect shows while this backend is down, and the one it
              // offers may have restarted since this page last read it.
              onReconnect={(url) => {
                refreshModelRegistry(url);
                handleSaveConfig({ ...config, deploymentUrl: url });
              }}
              // The backend may have restarted with other models or experts,
              // or not have been up when the page loaded. A project read
              // already in progress (the first one, retrying while the
              // backend was down) answers for this return too.
              onOnline={() => {
                refreshBackendLists(deploymentUrl);
                if (!projectsRefreshing) void refreshProjects();
              }}
            />
            <ThemeToggle />
            <Button
              ref={inspectorToggleRef}
              variant="ghost"
              size="icon"
              onClick={toggleInspector}
              aria-label={inspector ? "Hide inspector" : "Show workspace"}
              title={inspector ? "Hide inspector" : "Show workspace"}
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
              ref={settingsGearRef}
              onClick={toggleSettings}
              aria-label="Settings"
              aria-pressed={settingsOpen}
              title="Settings"
              className={cn("size-8", settingsOpen && "bg-accent")}
            >
              <Settings
                className="size-5"
                aria-hidden="true"
              />
            </Button>
          </div>
        </header>

        <FilePaneProvider
          onReveal={revealFilePane}
          inspectorOpen={Boolean(inspector)}
          inspectorToggleRef={inspectorToggleRef}
          returnFocusOnClose={!(sidebar && isDesktopLayout === false)}
        >
          <div className="relative flex-1 overflow-hidden">
            <FilePaneSizer
              panelRef={inspectorPanelRef}
              sidebarRef={threadPanelRef}
              sidebarOpen={Boolean(sidebar && isDesktopLayout)}
              workspaceTab={inspectorTab !== "agents"}
              inspectorOpen={Boolean(inspector && isDesktopLayout)}
            />
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
                  aria-label="Close inspector"
                  className="absolute inset-0 bg-black/40"
                  onClick={closeInspector}
                />
                <aside
                  aria-label="Inspector"
                  className="relative z-10 h-full w-[min(22rem,calc(100vw-2.25rem))] bg-background shadow-xl has-[[data-file-pane=preview]]:w-full"
                >
                  <InspectorPanel
                    onClose={closeInspector}
                    onReportToMainChat={notifyMainChat}
                  />
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
                    ref={threadPanelRef}
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
                {/* Chat stays mounted across view switches. We hide it via
                  `display:none` (rather than unmounting) so flipping to
                  Skills/Memory and back is instant — no thread re-fetch, no
                  message-list rebuild, and any in-flight run keeps streaming
                  in the background. Cost is bounded: only the *current*
                  thread's state is held; no accumulation per switch. */}
                <div
                  className={cn(
                    "flex h-full min-h-0 flex-1 flex-col",
                    view !== null && "hidden"
                  )}
                >
                  <SetupNotice onOpenSetup={() => void setView("setup")} />
                  <ChatProvider
                    key={chatSessionRevision}
                    onHistoryRevalidate={() => mutateThreads?.()}
                    onThreadUnavailable={handleThreadUnavailable}
                  >
                    <ChatInterface
                      draftSeed={composerSeed}
                      onComposerSnapshotReady={(getSnapshot) => {
                        composerSnapshotRef.current = getSnapshot;
                      }}
                      onShowAgents={showAgentsInspector}
                      onNotifyReady={(fn) => setNotifyMainChat(() => fn)}
                      onNavigate={handleDashboardNav}
                      onOpenThread={selectThread}
                      workspaceOpen={Boolean(
                        inspector && inspectorTab !== "agents"
                      )}
                    />
                  </ChatProvider>
                </div>
                {(view === "settings" || view === "setup") && (
                  <SetupView
                    key={backendKey}
                    entry={view}
                    onClose={closeSettings}
                    onSaveDeploymentUrl={saveDeploymentUrl}
                    onFormShown={() => void setView("settings")}
                  />
                )}
                {view === "skills" && <SkillsMarketplace />}
                {view === "experts" && <ExpertsPanel />}
                {view === "memory" && (
                  <MemoryPanel
                    initialTab={
                      memoryTab as
                        | "identity"
                        | "knowledge"
                        | "history"
                        | null
                        | undefined
                    }
                    initialObsId={memoryObs}
                    initialExecId={memoryExec}
                  />
                )}
                {view === "schedule" && (
                  <ScheduledTasksPanel
                    key={backendKey}
                    onOpenThread={selectThread}
                  />
                )}
              </ResizablePanel>

              {inspector && isDesktopLayout && (
                <>
                  <InspectorResizeHandle
                    panelRef={inspectorPanelRef}
                    workspaceTab={inspectorTab !== "agents"}
                  />
                  <ResizablePanel
                    ref={inspectorPanelRef}
                    id="inspector"
                    order={3}
                    defaultSize={26}
                    minSize={20}
                    className="relative min-w-[300px]"
                  >
                    <InspectorPanel
                      onClose={closeInspector}
                      onReportToMainChat={notifyMainChat}
                    />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </div>
        </FilePaneProvider>
      </div>
    </>
  );
}

function HomePageContent() {
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);

  // On mount, check for saved config, otherwise show config dialog
  useEffect(() => {
    const savedConfig = getConfig();
    if (savedConfig) {
      setConfig(savedConfig);
    } else {
      setConfigDialogOpen(true);
    }
    setConfigLoaded(true);
  }, []);

  const handleSaveConfig = useCallback((newConfig: DeploymentConfig) => {
    if (!saveConfig(newConfig)) {
      toast.error(
        "Couldn't save the settings: this browser's storage is full or blocked. They apply until the page is reloaded."
      );
    }
    setConfig(newConfig);
  }, []);

  const langsmithApiKey =
    config?.langsmithApiKey || process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "";

  // Saved configuration is browser-only. Until it has been read, avoid flashing
  // the first-time setup screen when reloading an existing conversation.
  if (!configLoaded) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p
          role="status"
          className="text-muted-foreground"
        >
          Loading…
        </p>
      </div>
    );
  }

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
      <ProjectsProvider
        deploymentUrl={config.deploymentUrl}
        apiKey={langsmithApiKey}
      >
        <HomePageInner
          config={config}
          handleSaveConfig={handleSaveConfig}
        />
      </ProjectsProvider>
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
