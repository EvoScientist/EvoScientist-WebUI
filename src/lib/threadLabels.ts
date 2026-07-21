function hasLabel(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export const THREAD_LABEL_STATE_KEY = "labels_state_updated_at";

export function needsThreadLabelBackfill(
  metadata: Record<string, unknown> | null | undefined,
  stateUpdatedAt?: string | null
): boolean {
  const md = metadata ?? {};
  if (hasLabel(md.auto_title) && hasLabel(md.preview)) return false;

  // Some valid threads have no messages (or no AI text), so one or both
  // labels cannot be derived. Remember that we already inspected this exact
  // graph state; if the thread later advances, state_updated_at changes and a
  // fresh backfill is allowed.
  return !stateUpdatedAt || md[THREAD_LABEL_STATE_KEY] !== stateUpdatedAt;
}

export function buildThreadLabelPatch(
  current: Record<string, unknown>,
  derived: { autoTitle: string | null; preview: string | null },
  stateUpdatedAt?: string | null
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (derived.autoTitle && current.auto_title !== derived.autoTitle) {
    patch.auto_title = derived.autoTitle;
  }
  if (derived.preview && current.preview !== derived.preview) {
    patch.preview = derived.preview;
  }
  if (stateUpdatedAt && current[THREAD_LABEL_STATE_KEY] !== stateUpdatedAt) {
    patch[THREAD_LABEL_STATE_KEY] = stateUpdatedAt;
  }
  return patch;
}
