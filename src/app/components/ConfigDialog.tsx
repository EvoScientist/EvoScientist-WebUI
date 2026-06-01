"use client";

import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { DEFAULT_ASSISTANT_ID, DeploymentConfig } from "@/lib/config";

interface ConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: DeploymentConfig) => void;
  initialConfig?: DeploymentConfig;
}

export function ConfigDialog({
  open,
  onOpenChange,
  onSave,
  initialConfig,
}: ConfigDialogProps) {
  const [deploymentUrl, setDeploymentUrl] = useState(
    initialConfig?.deploymentUrl || "http://127.0.0.1:6174"
  );
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      if (initialConfig) setDeploymentUrl(initialConfig.deploymentUrl);
    }
  }, [open, initialConfig]);

  const handleSave = () => {
    const url = deploymentUrl.trim();
    if (!url) {
      setError("Enter your deployment URL to continue.");
      inputRef.current?.focus();
      return;
    }
    try {
      new URL(url);
    } catch {
      setError("Enter a valid URL, e.g. http://127.0.0.1:6174");
      inputRef.current?.focus();
      return;
    }

    onSave({
      deploymentUrl: url,
      // Fixed to the EvoScientist main agent (see DEFAULT_ASSISTANT_ID).
      assistantId: DEFAULT_ASSISTANT_ID,
    });
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent className="sm:max-w-[525px]">
        <DialogHeader>
          <DialogTitle>Configuration</DialogTitle>
          <DialogDescription>
            Enter the URL of your EvoScientist deployment (from{" "}
            <code>EvoSci deploy</code>). This is saved in your browser&apos;s
            local storage.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="deploymentUrl">Deployment URL</Label>
            <Input
              ref={inputRef}
              id="deploymentUrl"
              name="deploymentUrl"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              placeholder="http://127.0.0.1:6174"
              value={deploymentUrl}
              onChange={(e) => {
                setDeploymentUrl(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing)
                  handleSave();
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "deploymentUrl-error" : undefined}
            />
            {error && (
              <p
                id="deploymentUrl-error"
                role="alert"
                aria-live="polite"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
