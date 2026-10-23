// The end of the system session as the window sees it. At sign-out Windows
// ends console processes such as `EvoSci deploy` right after it asks the
// session-end question (exit code 0x40010004, measured on 2026-10-23), before
// the window's `session-end` event, so the app sees its backend go first. An
// exit within the grace period after the question is held back: when
// `session-end` follows, the app is about to end and shows nothing; when the
// sign-out is cancelled (no `session-end`), the error shows after the grace
// period.

export const SESSION_QUERY_GRACE_MS = 10_000;

export class SessionEnd {
  private queriedAt: number | null = null;
  private ended = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly later: (fn: () => void, ms: number) => void = (fn, ms) =>
      void setTimeout(fn, ms)
  ) {}

  /** The window got `query-session-end`. */
  queried(): void {
    this.queriedAt = this.now();
  }

  /** The window got `session-end` (or macOS reported a shutdown). */
  end(): void {
    this.ended = true;
  }

  get ending(): boolean {
    return this.ended;
  }

  /** Shows an error now, after the grace period when a session-end question
   *  came shortly before (unless the session ended meanwhile), or never when
   *  the session is ending. */
  report(show: () => void): "now" | "deferred" | "dropped" {
    if (this.ended) return "dropped";
    const since =
      this.queriedAt === null ? Infinity : this.now() - this.queriedAt;
    if (since >= SESSION_QUERY_GRACE_MS) {
      show();
      return "now";
    }
    this.later(() => {
      if (!this.ended) show();
    }, SESSION_QUERY_GRACE_MS - since);
    return "deferred";
  }
}
