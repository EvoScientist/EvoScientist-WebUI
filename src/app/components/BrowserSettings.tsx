"use client";

// The Settings page's "This browser" group: which EvoScientist this page
// talks to (Connection) and how the chat shows agent actions (Display). Both
// live in this browser and apply at once, unlike the General group above
// them, which is saved in config.yaml and waits for a restart.

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsCard } from "@/app/components/SettingsCard";
import { deploymentUrlError, sameDeploymentUrl } from "@/lib/deploymentUrl";
import { useCollapseAgentActions } from "@/lib/uiSettings";

interface BrowserSettingsProps {
  /** The address this page talks to now. */
  deploymentUrl: string;
  /** Switch to another address (already validated and trimmed). */
  onSaveDeploymentUrl: (url: string) => void;
  /** The General group holds edits a switch would drop. */
  hasUnsavedEdits: boolean;
  /** The General group is saving; a switch now would cut it off. */
  saving: boolean;
}

export function BrowserSettings({
  deploymentUrl,
  onSaveDeploymentUrl,
  hasUnsavedEdits,
  saving,
}: BrowserSettingsProps) {
  const [url, setUrl] = useState(deploymentUrl);
  const [seededFrom, setSeededFrom] = useState(deploymentUrl);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const saveRef = useRef<HTMLButtonElement | null>(null);
  const { value: collapseAgentActions, setValue: setCollapseAgentActions } =
    useCollapseAgentActions();

  // Follow a new address from the page (a Reconnect, another tab's save).
  if (seededFrom !== deploymentUrl) {
    setSeededFrom(deploymentUrl);
    setUrl(deploymentUrl);
    setError(null);
  }

  const save = () => {
    // A switch remounts the page: the General save would end unseen.
    if (saving) return;
    const problem = deploymentUrlError(url);
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    const next = url.trim();
    if (sameDeploymentUrl(next, deploymentUrl)) return;
    if (hasUnsavedEdits) {
      setConfirming(next);
      return;
    }
    onSaveDeploymentUrl(next);
  };

  return (
    <div className="space-y-4">
      {/* Laid out like the General fields above it (SetupFields'
          FieldShell): label, description, input, then any error. */}
      <SettingsCard>
        <fieldset
          id="settings-connection"
          tabIndex={-1}
          className="scroll-mt-9 space-y-4 focus:outline-none"
        >
          <legend className="mb-2 text-sm font-semibold">Connection</legend>
          <div className="space-y-1.5">
            <Label htmlFor="settings-deployment-url">Deployment URL</Label>
            <p
              id="settings-deployment-url-description"
              className="text-xs text-muted-foreground"
            >
              Which EvoScientist this page talks to: your local one (found
              automatically) or a public URL from EvoSci deploy.
            </p>
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                id="settings-deployment-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="http://127.0.0.1:6174"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  // keyCode 229: Safari's Enter that ends an IME composition.
                  if (
                    e.key === "Enter" &&
                    !e.nativeEvent.isComposing &&
                    e.keyCode !== 229
                  ) {
                    save();
                  }
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={
                  error
                    ? "settings-deployment-url-description settings-deployment-url-error"
                    : "settings-deployment-url-description"
                }
              />
              <Button
                ref={saveRef}
                type="button"
                onClick={save}
                disabled={saving}
                aria-label="Save deployment URL"
                className="max-md:min-h-11"
              >
                Save
              </Button>
            </div>
            {error && (
              <p
                id="settings-deployment-url-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </div>
        </fieldset>
      </SettingsCard>

      <SettingsCard>
        <fieldset
          id="settings-display"
          tabIndex={-1}
          className="scroll-mt-9 space-y-4 focus:outline-none"
        >
          <legend className="mb-2 text-sm font-semibold">Display</legend>
          <div className="flex items-start gap-2">
            <input
              id="settings-collapse-agent-actions"
              type="checkbox"
              checked={collapseAgentActions}
              onChange={(e) => setCollapseAgentActions(e.target.checked)}
              aria-label="Collapse agent actions by default"
              aria-describedby="settings-collapse-agent-actions-description"
              className="mt-1 size-4 rounded border border-muted-foreground bg-transparent text-[var(--brand-solid)] focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            />
            <Label
              htmlFor="settings-collapse-agent-actions"
              className="text-sm font-normal leading-snug"
            >
              Collapse agent actions by default
              <span
                id="settings-collapse-agent-actions-description"
                className="block text-xs text-muted-foreground"
              >
                Keeps tool-call sequences folded while running and after
                completion. Approval controls remain visible.
              </span>
            </Label>
          </div>
        </fieldset>
      </SettingsCard>

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          // This dialog has no trigger for Radix to return focus to.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            saveRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Discard unsaved changes in General?</DialogTitle>
            <DialogDescription>
              Your edits under General have not been saved. Connecting to{" "}
              {confirming} drops them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirming(null)}
            >
              Keep Editing
            </Button>
            <Button
              disabled={saving}
              onClick={() => {
                const next = confirming;
                setConfirming(null);
                if (next && !saving) onSaveDeploymentUrl(next);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard and connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
