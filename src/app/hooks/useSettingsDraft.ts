"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { refreshModelRegistry } from "@/app/hooks/useAvailableModels";
import { useDeployment } from "@/providers/ClientProvider";
import type { SettingsPayload } from "@/lib/settings";
import {
  applyEdit,
  draftErrors,
  keyedBaseUrlErrors,
  keyIsSet,
  currentText,
  patchBody,
  saveErrorText,
  sendableEdits,
  testKeyErrorText,
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

  // The revision the unsaved changes were made against. The settings are
  // read again whenever the tab gets focus, so the latest revision would
  // let a save overwrite a change made elsewhere meanwhile; this one makes
  // the backend refuse it (409 revision_mismatch).
  const baseRevision = useRef<{ revision: string | null } | null>(null);

  // One number per provider, raised whenever its check stops applying (its
  // key or address changed, a save, Discard). A check answers only while its
  // number is current, so an answer for the old key never shows next to the
  // new one, nor ends the "checking" of a newer check.
  const checkSeq = useRef<Record<string, number>>({});
  const dropChecks = useCallback((providers: ReadonlyArray<string> | null) => {
    const names = providers ?? Object.keys(checkSeq.current);
    for (const name of names) {
      checkSeq.current[name] = (checkSeq.current[name] ?? 0) + 1;
    }
    const keep = <T>(c: Record<string, T>) =>
      providers === null
        ? {}
        : Object.fromEntries(
            Object.entries(c).filter(([name]) => !names.includes(name))
          );
    setChecks(keep);
    setChecking(keep);
  }, []);

  const setField = useCallback(
    (field: string, value: string | null, secret: boolean) => {
      if (!payload) return;
      setEdits((e) => {
        if (Object.keys(e).length === 0 && baseRevision.current === null) {
          baseRevision.current = { revision: payload.revision };
        }
        const next = applyEdit(e, payload, field, value, { secret });
        // Undone edits start again from the revision read then.
        if (Object.keys(next).length === 0) baseRevision.current = null;
        return next;
      });
      // A changed value answers the error and the warning it had, and the
      // check of a key or address that changed no longer applies.
      setServerErrors(({ [field]: _e, ...rest }) => rest);
      setWarnings(({ [field]: _w, ...rest }) => rest);
      dropChecks(
        ["tavily", ...Object.keys(payload.providers)].filter((provider) => {
          const info = payload.providers[provider];
          const fields =
            provider === "tavily"
              ? ["tavily_api_key"]
              : [info?.key_field, info?.base_url_field];
          return fields.includes(field);
        })
      );
    },
    [payload, dropChecks]
  );

  const discard = useCallback(() => {
    setEdits({});
    setServerErrors({});
    setWarnings({});
    dropChecks(null);
    setMessage(null);
    baseRevision.current = null;
  }, [dropChecks]);

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

  const localErrors = useMemo(
    () => ({
      ...draftErrors(sendable),
      ...(payload ? keyedBaseUrlErrors(sendable, payload) : {}),
    }),
    [payload, sendable]
  );

  const fieldErrors = useMemo(
    () => ({ ...serverErrors, ...localErrors }),
    [serverErrors, localErrors]
  );

  const save = useCallback(async (): Promise<SaveOutcome> => {
    if (!payload) return { ok: false, fieldErrors: {} };
    if (Object.keys(localErrors).length > 0) {
      return { ok: false, fieldErrors: localErrors };
    }
    setSaving(true);
    setMessage(null);
    try {
      let res: Response;
      try {
        res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            patchBody(
              sendable,
              (baseRevision.current ?? { revision: payload.revision }).revision
            )
          ),
        });
      } catch {
        setMessage("The WebUI server did not answer. Nothing was saved.");
        return { ok: false, fieldErrors: {} };
      }
      const body: unknown = await res.json().catch(() => null);
      if (res.ok) {
        // A 200 without the expected body still saved; read what is there.
        const raw = (body ?? {}) as Partial<SaveResult>;
        const result: SaveResult = {
          revision: raw.revision ?? null,
          changed: raw.changed ?? [],
          restart_required: raw.restart_required === true,
          restart_fields: raw.restart_fields ?? [],
          warnings: raw.warnings ?? {},
        };
        setEdits({});
        baseRevision.current = null;
        setServerErrors({});
        setWarnings(result.warnings);
        dropChecks(null);
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
      const conflict = body as { error?: unknown; revision?: unknown } | null;
      if (conflict?.error === "revision_mismatch") {
        // The refresh below shows the change; the next save is made against
        // that revision, so a further change elsewhere is caught again.
        baseRevision.current = {
          revision:
            typeof conflict.revision === "string" ? conflict.revision : null,
        };
      }
      // A conflict or a refusal: show what is saved now, keep the edits.
      await refresh();
      return { ok: false, fieldErrors: {} };
    } finally {
      setSaving(false);
    }
  }, [sendable, localErrors, payload, refresh, deploymentUrl, dropChecks]);

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
      // EvoScientist tests a key it has only against the saved address.
      if (
        request.base_url &&
        !request.key &&
        keyField &&
        payload &&
        keyIsSet(payload, keyField)
      ) {
        dropChecks([provider]);
        setChecks((c) => ({
          ...c,
          [provider]: {
            error: "Enter the API key to test it with the new address.",
          },
        }));
        return;
      }
      checkSeq.current[provider] = (checkSeq.current[provider] ?? 0) + 1;
      const seq = checkSeq.current[provider];
      const current = () => checkSeq.current[provider] === seq;
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
              ? testKeyErrorText(errors)
              : saveErrorText(body, res.status),
          };
        }
        if (current()) setChecks((c) => ({ ...c, [provider]: result }));
      } catch {
        if (current()) {
          setChecks((c) => ({
            ...c,
            [provider]: { error: "The WebUI server did not answer." },
          }));
        }
      } finally {
        if (current()) setChecking((c) => ({ ...c, [provider]: false }));
      }
    },
    [edits, payload, dropChecks]
  );

  return {
    edits,
    fieldErrors,
    warnings,
    message,
    saving,
    blocked: Object.keys(localErrors).length > 0,
    checks,
    checking,
    setField,
    discard,
    save,
    testKey,
  };
}
