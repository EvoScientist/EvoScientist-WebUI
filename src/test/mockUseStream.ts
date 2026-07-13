// A hand-rolled replacement for `useStream` from `@langchain/langgraph-sdk/react`.
//
// Tests install a MockStreamStore in beforeEach, then drive it via imperative
// controls (setInterrupt, setMessages, setLoading, ...). The mock hook body
// reads from the store via `useSyncExternalStore`, so React re-renders any
// component that consumed the returned stream whenever the test pushes new
// state. Submit/stop calls made by useChat are recorded on the store and
// available for assertion via getSubmitCalls / getStopCalls.
//
// Boilerplate at the top of each test file (must be at module top-level so
// vitest hoisting works correctly):
//
//   vi.mock("@langchain/langgraph-sdk/react", async (importOriginal) => {
//     const actual = await importOriginal<any>();
//     return { ...actual, useStream: useMockStreamHook };
//   });

import { useSyncExternalStore } from "react";
import type { Message } from "@langchain/langgraph-sdk";

interface MockStreamSnapshot<S> {
  values: S;
  messages: Message[];
  isLoading: boolean;
  isThreadLoading: boolean;
  interrupt: unknown | undefined;
  error: unknown;
}

export interface SubmitCall {
  values: unknown;
  options: unknown;
}

function defaultSnapshot<S>(): MockStreamSnapshot<S> {
  return {
    values: {} as S,
    messages: [],
    isLoading: false,
    isThreadLoading: false,
    interrupt: undefined,
    error: undefined,
  };
}

export class MockStreamStore<
  S extends Record<string, unknown> = Record<string, unknown>
> {
  private snap: MockStreamSnapshot<S> = defaultSnapshot<S>();
  private listeners = new Set<() => void>();
  private submitCalls: SubmitCall[] = [];
  private stopCallCount = 0;
  private lastOptions: Record<string, unknown> | null = null;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = (): MockStreamSnapshot<S> => this.snap;

  captureOptions(options: Record<string, unknown>): void {
    this.lastOptions = options;
  }

  private update(patch: Partial<MockStreamSnapshot<S>>): void {
    this.snap = { ...this.snap, ...patch };
    this.notify();
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  setValues(values: Partial<S>): void {
    this.update({
      values: { ...(this.snap.values as object), ...values } as S,
    });
  }

  setMessages(messages: Message[]): void {
    this.update({ messages });
  }

  setInterrupt(interrupt: unknown): void {
    this.update({ interrupt });
  }

  setLoading(isLoading: boolean): void {
    this.update({ isLoading });
  }

  setThreadLoading(isThreadLoading: boolean): void {
    this.update({ isThreadLoading });
  }

  setError(error: unknown): void {
    this.update({ error });
  }

  // Fire the callbacks that useChat registered via useStream(options).
  emitUpdateEvent(data: unknown, namespace: string[] = []): void {
    const cb = this.lastOptions?.onUpdateEvent as
      | ((d: unknown, o: { namespace: string[] }) => void)
      | undefined;
    cb?.(data, { namespace });
  }

  emitError(error: unknown): void {
    const cb = this.lastOptions?.onError as ((e: unknown) => void) | undefined;
    cb?.(error);
  }

  emitCreated(): void {
    const cb = this.lastOptions?.onCreated as (() => void) | undefined;
    cb?.();
  }

  emitFinish(): void {
    const cb = this.lastOptions?.onFinish as (() => void) | undefined;
    cb?.();
  }

  submit = async (values: unknown, options?: unknown): Promise<void> => {
    this.submitCalls.push({ values, options });
  };

  stop = async (): Promise<void> => {
    this.stopCallCount += 1;
  };

  getSubmitCalls(): SubmitCall[] {
    return [...this.submitCalls];
  }

  getStopCallCount(): number {
    return this.stopCallCount;
  }
}

let activeStore: MockStreamStore | null = null;

export function installMockStreamStore(store: MockStreamStore): void {
  activeStore = store;
}

export function clearMockStreamStore(): void {
  activeStore = null;
}

/**
 * The hook body that `vi.mock` swaps in for the SDK's `useStream`. Dispatches
 * to whatever store the current test installed via `installMockStreamStore`.
 */
export function useMockStreamHook(options: Record<string, unknown>) {
  if (!activeStore) {
    throw new Error(
      "useMockStreamHook called before installMockStreamStore(). " +
        "Call installMockStreamStore(new MockStreamStore()) in beforeEach()."
    );
  }
  const store = activeStore;
  store.captureOptions(options);
  const snap = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  return {
    values: snap.values,
    messages: snap.messages,
    isLoading: snap.isLoading,
    isThreadLoading: snap.isThreadLoading,
    interrupt: snap.interrupt,
    error: snap.error,
    submit: store.submit,
    stop: store.stop,
    // Fill-in stubs for UseStream fields useChat doesn't consume.
    branch: "main",
    setBranch: () => {},
    history: [],
    experimental_branchTree: { items: [] },
    // Metadata-driven rendering (e.g. per-message branch info in
    // ChatMessage) is OUT OF SCOPE for this harness — callers get
    // `undefined` and any consumer that gates behavior on metadata
    // has to be tested elsewhere. If a scenario needs to distinguish
    // messages by first-seen-thread-state, expose a store hook and
    // seed it explicitly instead of relying on the mock's silence.
    getMessagesMetadata: () => undefined,
    joinStream: async () => {},
    client: options?.client ?? {},
    assistantId: (options?.assistantId as string | undefined) ?? "",
  };
}
