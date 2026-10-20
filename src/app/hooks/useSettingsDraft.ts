"use client";

import { useCallback, useMemo, useState } from "react";
import { refreshModelRegistry } from "@/app/hooks/useAvailableModels";
import { useDeployment } from "@/providers/ClientProvider";
import type { SettingsPayload } from "@/lib/settings";
import {
  applyEdit,
  draftErrors,
  currentText,
  patchBody,
  saveErrorText,
  sendableEdits,
  type Edits,
  type KeyCheckResult,
} from "@/lib/settingsForm";

/** The PATCH /api/settings answer on success. */
export interface SaveResult {
  revision: string | null;
  changed: string[];
  restart_required: boolean;
  restart_fields: string[];
  warnings: Record<string, string>;
}

export type SaveOutcome =
  | { ok: true; result: SaveResult }
  | { ok: false; fieldErrors: Record<string, string> };

export interface SettingsDraft {
  edits: Edits;
  /** Errors next to fields: the page's own checks, then the backend's. */
  fieldErrors: Record<string, string>;
  /** Warnings of the last save, next to the fields they name. */
  warnings: Record<string, string>;
  /** A message about the whole save (a conflict, a refusal). */
  message: string | null;
  saving: boolean;
  /** The page's own checks refuse a save (see draftErrors). */
  blocked: boolean;
  /** Key checks by provider (or "tavily"), and which are running. */
  checks: Record<string, KeyCheckResult | { error: string }>;
  checking: Record<string, boolean>;
  setField: (field: string, value: string | null, secret: boolean) => void;
  discard: () => void;
  save: () => Promise<SaveOutcome>;
  testKey: (args: {
    provider: string;
    keyField: string | null;
    baseUrlField: string | null;
  }) => Promise<void>;
}

/**
 * Unsaved changes to the backend settings and the requests that save or check
 * them. Shared by the Setup view's form and its wizard. Typed keys live only
 * in this state: never in storage, URLs or logs, and gone after a save.
 */
export function useSettingsDraft(
  payload: SettingsPayload | undefined,
  refresh: () => Promise<unknown>
): SettingsDraft {
  const { deploymentUrl } = useDeployment();
  const [edits, setEdits] = useState<Edits>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checks, setChecks] = useState<SettingsDraft["checks"]>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});

  const setField = useCallback(
    (field: string, value: string | null, secret: boolean) => {
      if (!payload) return;
      setEdits((e) => applyEdit(e, payload, field, value, { secret }));
      // A changed value answers the error and the warning it had.
      setServerErrors(({ [field]: _e, ...rest }) => rest);
      setWarnings(({ [field]: _w, ...rest }) => rest);
    },
    [payload]
  );

  const discard = useCallback(() => {
    setEdits({});
    setServerErrors({});
    setMessage(null);
  }, []);

  // What a save sends: the selected provider's key fields, not another's.
  const sendable = useMemo(
    () =>
      payload
        ? sendableEdits(
            edits,
            payload.providers,
            currentText(payload, edits, "provider")
          )
        : edits,
    [payload, edits]
  );

  const fieldErrors = useMemo(
    () => ({ ...serverErrors, ...draftErrors(sendable) }),
    [serverErrors, sendable]
  );

  const save = useCallback(async (): Promise<SaveOutcome> => {
    if (!payload) return { ok: false, fieldErrors: {} };
    const local = draftErrors(sendable);
    if (Object.keys(local).length > 0) return { ok: false, fieldErrors: local };
    setSaving(true);
    setMessage(null);
    try {
      let res: Response;
      try {
        res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchBody(sendable, payload.revision)),
        });
      } catch {
        setMessage("The WebUI server did not answer. Nothing was saved.");
        return { ok: false, fieldErrors: {} };
      }
      const body: unknown = await res.json().catch(() => null);
      if (res.ok) {
        const result = body as SaveResult;
        setEdits({});
        setServerErrors({});
        setWarnings(result.warnings ?? {});
        await refresh();
        refreshModelRegistry(deploymentUrl);
        return { ok: true, result };
      }
      const errors = (body as { errors?: unknown } | null)?.errors;
      if (res.status === 400 && typeof errors === "object" && errors) {
        const byField = errors as Record<string, string>;
        setServerErrors(byField);
        return { ok: false, fieldErrors: byField };
      }
      setMessage(saveErrorText(body, res.status));
      // A conflict or a refusal: show what is saved now, keep the edits.
      await refresh();
      return { ok: false, fieldErrors: {} };
    } finally {
      setSaving(false);
    }
  }, [sendable, payload, refresh, deploymentUrl]);

  const testKey = useCallback(
    async ({
      provider,
      keyField,
      baseUrlField,
    }: {
      provider: string;
      keyField: string | null;
      baseUrlField: string | null;
    }) => {
      // Only what the user typed goes along; without it the backend tests
      // the stored key against the stored address.
      const request: Record<string, string> = { provider };
      const key = keyField ? edits[keyField] : null;
      if (typeof key === "string" && key) request.key = key;
      const baseUrl = baseUrlField ? edits[baseUrlField] : null;
      if (typeof baseUrl === "string" && baseUrl) request.base_url = baseUrl;
      setChecking((c) => ({ ...c, [provider]: true }));
      try {
        const res = await fetch("/api/settings/test-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        const body: unknown = await res.json().catch(() => null);
        let result: KeyCheckResult | { error: string };
        if (res.ok) {
          result = body as KeyCheckResult;
        } else {
          const errors = (body as { errors?: Record<string, string> } | null)
            ?.errors;
          result = {
            error: errors
              ? Object.values(errors).join(" ")
              : saveErrorText(body, res.status),
          };
        }
        setChecks((c) => ({ ...c, [provider]: result }));
      } catch {
        setChecks((c) => ({
          ...c,
          [provider]: { error: "The WebUI server did not answer." },
        }));
      } finally {
        setChecking((c) => ({ ...c, [provider]: false }));
      }
    },
    [edits]
  );

  return {
    edits,
    fieldErrors,
    warnings,
    message,
    saving,
    blocked: Object.keys(draftErrors(sendable)).length > 0,
    checks,
    checking,
    setField,
    discard,
    save,
    testKey,
  };
}
