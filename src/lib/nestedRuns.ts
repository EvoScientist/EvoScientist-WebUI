import type { Client } from "@langchain/langgraph-sdk";

// The goal drafter and the rubric grader are agents a middleware runs inside
// the main graph. With streamSubgraphs their events arrive under namespaces
// such as "GoalMiddleware.before_agent:<id>|draft_goal:<id>" and
// "EvoRubricMiddleware.after_agent:<id>", and the SDK (1.9.25,
// ui/manager.js) takes a `values|<ns>` event whose namespace has no "tools:"
// segment for the main conversation's values: while one of them runs, the
// chat shows only its prompt and its reply (probe P5, 2026-10-24).
// Sub-agents of the task tool stream under "tools:<id>", which the SDK routes
// to stream.subagents, so they pass. Custom events pass too: goal_state
// "drafting" comes from a nested namespace.

/** Whether a stream event is a middleware's nested run's (not a sub-agent's)
 *  and not a custom event. */
export function isNestedRunEvent(event: string): boolean {
  const [kind, ...namespace] = event.split("|");
  if (namespace.length === 0 || kind === "custom") return false;
  return !namespace[0].startsWith("tools:");
}

async function* withoutNested<T extends { event: string }>(
  stream: AsyncIterable<T>
): AsyncGenerator<T> {
  for await (const chunk of stream) {
    if (!isNestedRunEvent(chunk.event)) yield chunk;
  }
}

type Streaming = (...args: unknown[]) => AsyncIterable<{ event: string }>;

/** `target` with `override` in front: every other member is read from the
 *  real object and its methods run on it. The SDK's clients fetch through a
 *  private method, which throws for any other receiver: on a copy made with
 *  Object.create, Stop's runs.cancel threw and the run went on server-side. */
function overlay<T extends object>(target: T, override: Partial<T>): T {
  const bound = new WeakMap<object, unknown>();
  return new Proxy(target, {
    get(real, prop) {
      if (Object.prototype.hasOwnProperty.call(override, prop)) {
        return override[prop as keyof T];
      }
      const value: unknown = Reflect.get(real, prop, real);
      if (typeof value !== "function") return value;
      // One bound copy per method, so a member reads the same each time.
      if (!bound.has(value)) bound.set(value, value.bind(real));
      return bound.get(value);
    },
  });
}

/** The same client, but its runs.stream and runs.joinStream skip nested
 *  runs' events. For useStream only; other calls keep the plain client. */
export function withoutNestedRuns(client: Client): Client {
  const runs = client.runs;
  const stream = runs.stream as unknown as Streaming;
  const joinStream = runs.joinStream as unknown as Streaming;
  return overlay(client, {
    runs: overlay(runs, {
      stream: ((...args: unknown[]) =>
        withoutNested(
          stream.apply(runs, args)
        )) as unknown as Client["runs"]["stream"],
      joinStream: ((...args: unknown[]) =>
        withoutNested(
          joinStream.apply(runs, args)
        )) as unknown as Client["runs"]["joinStream"],
    }),
  });
}
