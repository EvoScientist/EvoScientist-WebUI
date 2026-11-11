"use client";

// The desktop app's update offer, as one notice that stays until it is
// closed: "Download" when an update is available, the progress while it
// downloads, then "Restart to update". The app checks on its own and
// downloads and installs only when asked; "Restart to update" asks first
// while work runs, as closing does. A notice the user closed comes back
// only with the next step or another version. The percent is not announced
// (aria-hidden): the toaster is a live region. In a plain browser nothing
// shows. The status page shows the same texts (desktop/src/screens.ts
// updateOffer).

import { useEffect } from "react";
import { toast } from "sonner";
import { desktopBridge, type AppUpdateState } from "@/lib/desktop";

const ID = "desktop-app-update";

/** What a "Restart to update" that did not happen says. */
const RESTART_NOTES: Record<string, string> = {
  busy: "The app is busy. Try again in a moment.",
  not_ready: "The downloaded installer could not be opened. Download it again.",
};

interface UpdateNotice {
  tone: "info" | "success" | "warning";
  text: string;
  percent: number | null;
  action: "download" | "restart" | null;
}

/** The notice for a state, or null when there is nothing to offer. */
function updateNotice(s: AppUpdateState): UpdateNotice | null {
  switch (s.kind) {
    case "none":
      return null;
    case "available":
      return s.failed
        ? {
            tone: "warning",
            text: `The download of EvoScientist ${s.version} did not finish.`,
            percent: null,
            action: "download",
          }
        : {
            tone: "info",
            text: `EvoScientist ${s.version} is available.`,
            percent: null,
            action: "download",
          };
    case "downloading":
      return {
        tone: "info",
        text: `Downloading EvoScientist ${s.version}...`,
        percent: s.percent,
        action: null,
      };
    case "ready":
      return {
        tone: "success",
        text: `EvoScientist ${s.version} is ready to install.`,
        percent: null,
        action: "restart",
      };
  }
}

/** A notice the user closed stays closed until the step or version changes. */
const stepOf = (s: AppUpdateState) =>
  s.kind === "none" ? "none" : `${s.kind}:${s.version}`;

export function DesktopUpdateNotice() {
  useEffect(() => {
    const update = desktopBridge()?.appUpdate;
    if (!update) return;
    /** The step the user closed. */
    let closed: string | null = null;
    /** The toast's id. sonner keeps a dismissed toast for 200 ms and merges
     *  a toast with the same id into it, so a toast that goes takes its id
     *  with it; and its `onDismiss`, which sonner also calls for our own
     *  dismiss, counts only while its id is current. */
    let id = ID;
    let ids = 0;
    let restarting = false;

    const show = (s: AppUpdateState, note?: string) => {
      const notice = updateNotice(s);
      if (!notice) {
        toast.dismiss(id);
        id = `${ID}-${++ids}`;
        return;
      }
      const step = stepOf(s);
      if (closed === step) return;
      closed = null;
      const mine = id;
      const label =
        notice.action === "download"
          ? "Download"
          : notice.action === "restart"
          ? "Restart to update"
          : null;
      const title =
        notice.percent === null ? (
          notice.text
        ) : (
          <>
            {notice.text}
            <span aria-hidden="true"> {notice.percent}%</span>
          </>
        );
      toast[notice.tone](title, {
        id: mine,
        duration: Infinity,
        description: note,
        onDismiss: () => {
          if (mine !== id) return;
          closed = step;
          id = `${ID}-${++ids}`;
        },
        action: label
          ? {
              label,
              onClick: (e) => {
                // The notice stays: the app's next state replaces it. Left to
                // sonner, the click removes it 200 ms later, together with
                // any update in between (a cached download is ready at once).
                e.preventDefault();
                if (notice.action === "download") {
                  void update.download();
                  return;
                }
                if (restarting) return;
                restarting = true;
                void update.restartToUpdate().then(async (r) => {
                  restarting = false;
                  // On success the app ends; otherwise the offer stays and
                  // says why, from the app's state now (an installer that
                  // could not be opened is offered for download again).
                  if (!r.ok) show(await update.state(), RESTART_NOTES[r.code]);
                });
              },
            }
          : undefined,
      });
    };

    const off = update.onState((s) => show(s));
    void update.state().then((s) => show(s));
    return () => {
      off();
      toast.dismiss(id);
    };
  }, []);
  return null;
}
