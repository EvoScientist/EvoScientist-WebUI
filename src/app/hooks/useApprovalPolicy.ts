"use client";

import { useEffect, useState } from "react";
import { interruptValueKey } from "@/app/hooks/useChat";
import { interruptIdOf, type ActionRequest, type Decision } from "@/lib/hitl";
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

// Tells credentials apart inside the answer's identity without keeping the key
// itself anywhere but the request header. Not a security boundary — djb2.
function credentialTag(apiKey: string | undefined): string {
  if (!apiKey) return "";
  let hash = 5381;
  for (let i = 0; i < apiKey.length; i++) {
    hash = ((hash << 5) + hash + apiKey.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
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
  // An answer belongs to one deployment, one credential, one interrupt and one
  // exact set of requests; any of them changing makes it a different question.
  // The requests are serialized once: the same snapshot is the key and the POST
  // body, so an answer can never be filed under requests other than the ones
  // sent. (`stream.interrupt` is a fresh object on every access — a string keeps
  // the effect's dependencies stable where the array could not.)
  const requestsJson = JSON.stringify(actionRequests);
  const questionKey =
    askable && base
      ? `${base}\n${credentialTag(apiKey)}\n${interruptKey}\n${requestsJson}`
      : null;

  const [settled, setSettled] = useState<{
    key: string;
    decisions: Decision[] | null;
  } | null>(null);

  useEffect(() => {
    if (!questionKey || !base || unsupportedDeployments.has(base)) return;
    const requests = JSON.parse(requestsJson) as ActionRequest[];
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
      body: `{"action_requests":${requestsJson}}`,
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.status === 404 || res.status === 405) {
          unsupportedDeployments.add(base);
          return settle(null);
        }
        if (!res.ok) return settle(null);
        settle(parsePolicyDecisions(await res.json(), requests));
      })
      // Timeout, network failure, bad JSON: a human decides.
      .catch(() => settle(null))
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [questionKey, base, apiKey, requestsJson]);

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
