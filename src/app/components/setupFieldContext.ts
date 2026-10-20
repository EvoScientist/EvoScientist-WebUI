// The state a Setup field reads, and the rules shared by the fields, the
// form and the wizard. Kept apart from SetupFields.tsx, which exports only
// components (React fast refresh).

import type { ModelRegistryEntry } from "@/app/hooks/useAvailableModels";
import type { SettingsDraft } from "@/app/hooks/useSettingsDraft";
import type { SettingsPayload } from "@/lib/settings";
import { currentText } from "@/lib/settingsForm";

export interface FieldContext {
  payload: SettingsPayload;
  draft: SettingsDraft;
  /** The page can save (WebUI#55, point 4). */
  writable: boolean;
}

export function shadowOf(ctx: FieldContext, field: string) {
  const source = ctx.payload.sources[field];
  return source?.shadowed ? source : null;
}

/** Whether a field takes input: the page can save, the backend lets this
 *  API change it, and no override hides the saved value. */
export function isEditable(ctx: FieldContext, field: string): boolean {
  return (
    ctx.writable &&
    !ctx.payload.read_only.includes(field) &&
    shadowOf(ctx, field) === null
  );
}

/** The current provider: the unsaved choice, else the saved one. */
export function currentProvider(ctx: FieldContext): string {
  return currentText(ctx.payload, ctx.draft.edits, "provider");
}

/** Model names to suggest: the registry's for the provider, then what the
 *  provider's key check listed. Any other name can be typed. */
export function modelSuggestions(
  ctx: FieldContext,
  registry: ReadonlyArray<ModelRegistryEntry>
): string[] {
  const provider = currentProvider(ctx);
  const check = ctx.draft.checks[provider];
  const listed = check && "models" in check ? check.models ?? [] : [];
  const names = registry
    .filter((e) => e.provider === provider)
    .map((e) => e.name)
    .concat(listed);
  return [...new Set(names)];
}
