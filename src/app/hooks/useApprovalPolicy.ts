"use client";

import { useEffect, useRef, useState } from "react";
import { interruptValueKey } from "@/app/hooks/useChat";
import { interruptIdOf, type Decision } from "@/lib/hitl";
import { parsePolicyDecisions } from "@/lib/hitlPolicy";

// Long enough for a local deployment to answer, short enough that a hung one
// costs the user a beat rather than the ability to approve by hand.
const POLICY_TIMEOUT_MS = 2000;

// Deployments without the route (EvoScientist < 0.3.1) are remembered per page
// load so every later interrupt settles immediately instead of paying a 404.
const unsupportedDeployments = new Set<string>();

/** Test hook: forget which deployments lacked the policy route. */
export function resetApprovalPolicySupport(): void {
  unsupportedDeployments.clear();
}

interface UseApprovalPolicyArgs {
  interrupt: unknown;
  deploymentUrl: string | null | undefined;
  apiKey?: string;
}

export interface ApprovalPolicy {
  /** Key of the interrupt these fields describe; null without an approval. */
  interruptKey: string | null;
  /** The deployment has not answered yet — keep the cards quiet. */
  checking: boolean;
  /** The deployment's decisions, or null when a human (or the local
   *  auto-approve policy) has to decide. */
  decisions: Decision[] | null;
}

function actionRequestsOf(interrupt: unknown): unknown[] {
  const raw = (interrupt as { value?: { action_requests?: unknown } } | null)
    ?.value?.action_requests;
  return Array.isArray(raw) ? raw : [];
}

/**
 * Asks the deployment's `POST /api/policy` what it already trusts for the
 * pending tool-approval interrupt — today that is `shell_allow_list` — so the
 * WebUI prompts exactly when the TUI would. (`auto_approve`, `auto_mode` and
 * `dangerous_mode` never get this far: they suppress the interrupt itself.)
 */
export function useApprovalPolicy({
  interrupt,
  deploymentUrl,
  apiKey,
}: UseApprovalPolicyArgs): ApprovalPolicy {
  const base = deploymentUrl ? deploymentUrl.replace(/\/$/, "") : null;
  const actionRequests = actionRequestsOf(interrupt);
  const interruptKey =
    actionRequests.length > 0 ? interruptValueKey(interrupt) : null;
  // Only interrupts with a real id are taken to the deployment. Without one the
  // key is the payload itself, which cannot tell a repeat of the same request
  // from the first — a remembered answer would keep its card quiet for good.
  const askable =
    interruptKey !== null && interruptIdOf(interrupt) !== undefined;
  // An answer belongs to one deployment, one interrupt and one exact set of
  // requests. Any of them changing makes it a different question.
  const questionKey =
    askable && base
      ? `${base}\n${interruptKey}\n${JSON.stringify(actionRequests)}`
      : null;

  // `stream.interrupt` is a fresh object on every access, so the effect is
  // keyed on the interrupt's content key and reads the requests from a ref.
  const actionRequestsRef = useRef(actionRequests);
  actionRequestsRef.current = actionRequests;

  const [settled, setSettled] = useState<{
    key: string;
    decisions: Decision[] | null;
  } | null>(null);

  useEffect(() => {
    if (!questionKey || !base || unsupportedDeployments.has(base)) return;
    const requests = actionRequestsRef.current;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLICY_TIMEOUT_MS);
    const settle = (decisions: Decision[] | null) => {
      if (!cancelled) setSettled({ key: questionKey, decisions });
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["X-Api-Key"] = apiKey;

    fetch(`${base}/api/policy`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action_requests: requests }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.status === 404 || res.status === 405) {
          unsupportedDeployments.add(base);
          return settle(null);
        }
        if (!res.ok) return settle(null);
        settle(
          parsePolicyDecisions(
            await res.json(),
            requests as Parameters<typeof parsePolicyDecisions>[1]
          )
        );
      })
      // Timeout, network failure, bad JSON: a human decides.
      .catch(() => settle(null))
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [questionKey, base, apiKey]);

  if (!interruptKey) {
    return { interruptKey: null, checking: false, decisions: null };
  }
  if (!questionKey || !base || unsupportedDeployments.has(base)) {
    return { interruptKey, checking: false, decisions: null };
  }
  if (settled?.key === questionKey) {
    return { interruptKey, checking: false, decisions: settled.decisions };
  }
  return { interruptKey, checking: true, decisions: null };
}
