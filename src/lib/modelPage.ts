// The `/` menu's Model page: which models to list for this chat, which one it
// uses now, and which is the backend's default.

import type { ModelRegistryEntry } from "@/app/hooks/useAvailableModels";
import { COMMON_MODELS, type ModelOverride } from "./modelCommand";

/** The models to list: the backend's registry, in the order it recommends,
 *  or the curated list where the registry didn't load. */
export function modelPageModels(
  entries: ReadonlyArray<ModelRegistryEntry>
): ModelOverride[] {
  if (entries.length > 0) {
    return entries.map((e) => ({ model: e.name, model_provider: e.provider }));
  }
  return COMMON_MODELS.map((m) => ({
    model: m.model,
    model_provider: m.model_provider,
  }));
}

/** A model row of the Model page. */
export interface ModelPageEntry {
  model: string;
  provider?: string;
  /** The model this chat runs on: its override, or the default without one. */
  current: boolean;
  /** The backend's default model. */
  isDefault: boolean;
}

/** The Model page's rows for `filter`: a case-insensitive substring of the
 *  name or the provider. A row matches the override or the default by name
 *  and provider together, as the backend routes them. */
export function modelPageEntries({
  models,
  override,
  defaultEntry,
  filter,
}: {
  models: readonly ModelOverride[];
  override: ModelOverride | null;
  defaultEntry: { name: string; provider: string | null } | null;
  filter: string;
}): ModelPageEntry[] {
  const q = filter.trim().toLowerCase();
  return models
    .filter(
      (m) =>
        !q ||
        m.model.toLowerCase().includes(q) ||
        (m.model_provider ?? "").toLowerCase().includes(q)
    )
    .map((m) => {
      const isDefault =
        defaultEntry?.name === m.model &&
        (defaultEntry.provider ?? null) === (m.model_provider ?? null);
      return {
        model: m.model,
        ...(m.model_provider ? { provider: m.model_provider } : {}),
        current: override
          ? override.model === m.model &&
            override.model_provider === m.model_provider
          : isDefault,
        isDefault,
      };
    });
}
