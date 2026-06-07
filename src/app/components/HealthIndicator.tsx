"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type HealthStatus = "checking" | "online" | "offline";

interface BackendInfo {
  version?: string;
  flags?: Record<string, boolean>;
}

interface HealthIndicatorProps {
  deploymentUrl: string;
}

const POLL_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 4_000;

// Theme tokens (light + dark defined in globals.css). The base's bg-primary /
// bg-secondary tokens are dead in this fork (see CLAUDE.md), so we reference the
// CSS vars directly via arbitrary-value classes (the entries below).
// NOTE: never write a bracketed class literal in a comment — Tailwind's content
// scanner picks it up and emits real (sometimes invalid) CSS.
const STATUS_META: Record<
  HealthStatus,
  { dot: string; label: string; pulse: boolean }
> = {
  checking: {
    dot: "bg-[var(--color-warning)]",
    label: "Connecting…",
    pulse: true,
  },
  online: {
    dot: "bg-[var(--color-success)]",
    label: "Connected",
    pulse: false,
  },
  offline: {
    dot: "bg-[var(--color-error)]",
    label: "Offline",
    pulse: false,
  },
};

/**
 * Top-bar connection health light. Polls the backend's unauthenticated
 * `GET /info` (a "simple" cross-origin GET — no custom headers, so no CORS
 * preflight) and shows green/amber/red. Proves the UI can actually reach the
 * langgraph backend, which is the single most confusing failure mode
 * ("page opens but never replies"). Click to re-check on demand.
 */
export function HealthIndicator({ deploymentUrl }: HealthIndicatorProps) {
  const [status, setStatus] = useState<HealthStatus>("checking");
  const [info, setInfo] = useState<BackendInfo | null>(null);
  // Monotonic id so a slow check against a previous URL can't clobber a newer one.
  const requestRef = useRef(0);

  const check = useCallback(async () => {
    const requestId = ++requestRef.current;
    const base = deploymentUrl.replace(/\/+$/, "");
    if (!base) {
      if (requestId === requestRef.current) {
        setInfo(null);
        setStatus("offline");
      }
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}/info`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (requestId !== requestRef.current) return;
      if (!response.ok) {
        setStatus("offline");
        return;
      }
      const data = (await response
        .json()
        .catch(() => null)) as BackendInfo | null;
      if (requestId !== requestRef.current) return;
      setInfo(data);
      setStatus("online");
    } catch {
      if (requestId === requestRef.current) setStatus("offline");
    } finally {
      clearTimeout(timeout);
    }
  }, [deploymentUrl]);

  useEffect(() => {
    setStatus("checking");
    check();
    const interval = setInterval(check, POLL_INTERVAL_MS);
    // Re-check when the tab regains focus or the network comes back, so a
    // transient outage clears itself without a manual refresh.
    const recheck = () => check();
    window.addEventListener("focus", recheck);
    window.addEventListener("online", recheck);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", recheck);
      window.removeEventListener("online", recheck);
    };
  }, [check]);

  const meta = STATUS_META[status];
  const title =
    status === "online"
      ? `Connected to ${deploymentUrl}${
          info?.version ? ` · langgraph ${info.version}` : ""
        }`
      : status === "offline"
      ? `Can't reach the backend at ${deploymentUrl}. Is "EvoSci deploy" running? Click to retry.`
      : `Checking connection to ${deploymentUrl}…`;

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={check}
      title={title}
      aria-label={title}
      className="h-8 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
    >
      <span
        className={`size-2 shrink-0 rounded-full ${meta.dot} ${
          meta.pulse ? "animate-pulse" : ""
        }`}
        aria-hidden="true"
      />
      <span className="hidden sm:inline">{meta.label}</span>
    </Button>
  );
}
