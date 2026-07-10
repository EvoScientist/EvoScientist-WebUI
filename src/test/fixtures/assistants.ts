import type { Assistant } from "@langchain/langgraph-sdk";

// Minimal shape that satisfies the Assistant type well enough for our tests.
// The real Assistant has more fields (context, checkpoint_id, etc.) but useChat
// only reads `assistant_id` and `config`, and the components read `name`.
export const fixtureAssistant: Assistant = {
  assistant_id: "EvoScientist",
  graph_id: "EvoScientist",
  name: "EvoScientist",
  config: {},
  metadata: {},
  version: 1,
  created_at: "2026-07-10T00:00:00Z",
  updated_at: "2026-07-10T00:00:00Z",
  description: null,
} as unknown as Assistant;

/** Same shape as fixtureAssistant but with a seeded configurable, so tests that
 *  care about config merging can distinguish assistant-level config from the
 *  per-thread overrides useChat folds in. */
export const fixtureAssistantWithConfig: Assistant = {
  ...fixtureAssistant,
  config: { configurable: { some_seed: "abc" } },
} as unknown as Assistant;
