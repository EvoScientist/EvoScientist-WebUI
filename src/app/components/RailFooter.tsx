"use client";

import {
  Bell,
  PanelRight,
  PanelRightClose,
  Settings,
  UserCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/app/components/ThemeToggle";

interface RailFooterProps {
  onOpenSettings: () => void;
  onToggleInspector: () => void;
  inspectorOpen: boolean;
}

/** Rail-bottom row. Left: user chip. Right: the three page-header controls
 *  that migrated down (theme, settings, inspector) plus a decorative bell.
 *  The bell has no click semantic in v1.
 *
 *  The three migrated controls keep their icon + tooltip shape identical to
 *  the pre-Pass-2 header buttons, so muscle-memory clicks land on the same
 *  affordances — just in a new location. */
export function RailFooter({
  onOpenSettings,
  onToggleInspector,
  inspectorOpen,
}: RailFooterProps) {
  return (
    <div className="mt-auto flex flex-shrink-0 items-center gap-1 border-t border-border px-2 py-2">
      <div className="flex items-center gap-2 pl-1 text-sm">
        <UserCircle
          className="size-6 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="font-medium text-foreground">You</span>
      </div>
      <div className="ml-auto flex items-center">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Notifications"
          title="Notifications"
          className="size-8 cursor-default text-muted-foreground hover:bg-transparent"
          tabIndex={-1}
          aria-disabled="true"
        >
          <Bell
            className="size-4"
            aria-hidden="true"
          />
        </Button>
        <ThemeToggle />
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings"
          className="size-8"
        >
          <Settings
            className="size-4"
            aria-hidden="true"
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleInspector}
          aria-label={inspectorOpen ? "Hide inspector" : "Show workspace"}
          title={inspectorOpen ? "Hide inspector" : "Show workspace"}
          className="size-8"
        >
          {inspectorOpen ? (
            <PanelRightClose
              className="size-4"
              aria-hidden="true"
            />
          ) : (
            <PanelRight
              className="size-4"
              aria-hidden="true"
            />
          )}
        </Button>
      </div>
    </div>
  );
}
