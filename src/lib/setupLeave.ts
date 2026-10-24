// "Configure later" from leaving Setup or Settings while setup is needed,
// counted only once the leave is real. Right after setView("setup") nuqs
// writes view=setup to the address bar, and a render can still report the old
// view until Next's router catches up (seen on a cold first run): taken as a
// leave, it turned a first run's wizard into the form. So a leave counts once
// the view the page renders and the address bar are both outside Setup and
// Settings. nuqs writes the address bar up to 3 x its throttle late (150 ms,
// 360 ms on Safari 17+, 960 ms on older Safari); still on Setup after that, it
// is where the user is, and where a reload goes.

/** The views that show EvoScientist's settings: the Settings page (the gear)
 *  and its first-run entry. The user has seen the fields in either. */
export const SETUP_VIEWS: ReadonlySet<string | null> = new Set([
  "setup",
  "settings",
]);

const SETTLE_MS = 150;
// About 1.5 s in all: past nuqs' slowest write of the address bar.
const MAX_CHECKS = 10;

export interface LeaveTracker {
  /** The view left Setup / Settings of `url` while setup is needed. */
  leave(url: string): void;
  /** The view is on Setup / Settings again, now for `url`. */
  back(url: string): void;
  /** The page is going away: keep a pending leave that the view and the
   *  address bar agree on. */
  flush(): void;
}

export function createLeaveTracker(deps: {
  /** Records "Configure later" for a deployment (setupDeferral). */
  record: (url: string) => void;
  /** The view the page renders now. */
  viewNow: () => string | null;
  /** The view in the address bar now. */
  urlViewNow: () => string | null;
}): LeaveTracker {
  let pending: { url: string; timer: ReturnType<typeof setTimeout> } | null =
    null;

  const end = (keep: boolean) => {
    if (!pending) return;
    clearTimeout(pending.timer);
    const { url } = pending;
    pending = null;
    if (keep) deps.record(url);
  };

  const schedule = (url: string, checks: number) => {
    pending = {
      url,
      timer: setTimeout(() => {
        pending = null;
        // Back on Setup or Settings: the leave was a flicker.
        if (SETUP_VIEWS.has(deps.viewNow())) return;
        if (!SETUP_VIEWS.has(deps.urlViewNow())) {
          deps.record(url);
          return;
        }
        // The address bar may not be written yet; past the last check it is
        // where the user is, and the leave is dropped.
        if (checks + 1 < MAX_CHECKS) schedule(url, checks + 1);
      }, SETTLE_MS),
    };
  };

  return {
    leave(url) {
      // A leave still waiting belongs to another visit of Setup: keep it.
      end(true);
      schedule(url, 0);
    },
    back(url) {
      // The same deployment back on Setup: the leave was a flicker. Another
      // deployment's leave was real (the page switched backend meanwhile).
      if (pending) end(pending.url !== url);
    },
    flush() {
      end(
        !SETUP_VIEWS.has(deps.viewNow()) && !SETUP_VIEWS.has(deps.urlViewNow())
      );
    },
  };
}
