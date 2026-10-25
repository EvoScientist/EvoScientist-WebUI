// Shared implementations for the mocks a ChatInterface integration test needs.
// Test files reference these from inside their top-level `vi.mock(...)`
// factories (dynamic-imported so they satisfy vitest's hoisting rules), and
// call `resetComponentSpy()` in `beforeEach`.

import type { ReactNode } from "react";

// Props spy — child components render as no-op divs but record the last set
// of props they were called with, keyed by name. Tests inspect via
// `getLastProps("ActionGroup")`.
const spy = new Map<string, unknown[]>();

export function stubComponent(name: string) {
  return function Stub(
    props: Record<string, unknown> & { children?: ReactNode }
  ) {
    const arr = spy.get(name) ?? [];
    arr.push(props);
    spy.set(name, arr);
    return (
      <div data-testid={`stub-${name}`}>{props.children as ReactNode}</div>
    );
  };
}

export function getLastProps<T = Record<string, unknown>>(
  name: string
): T | undefined {
  const arr = spy.get(name);
  if (!arr || arr.length === 0) return undefined;
  return arr[arr.length - 1] as T;
}

export function getAllProps<T = Record<string, unknown>>(name: string): T[] {
  return (spy.get(name) ?? []) as T[];
}

export function resetComponentSpy(): void {
  spy.clear();
}

// Peripheral hook mocks — return default-idle shapes matching each real hook's
// return type. Tests can override by rewriting the vi.mock factory if a
// scenario needs a different value.

export const useAsyncAgentsMock = () => ({
  tasks: [],
  loaded: true,
  error: null,
  refresh: () => {},
});

export const useAutoNotifyMock = (): [boolean, (on: boolean) => void] => [
  false,
  () => {},
];

// Populated by default so ChatInterface's fallback-list diagnostic warn
// (fires when the registry settles empty) doesn't spam stderr in every test.
// A test sets `registryStub.failed` (and puts it back) to cover the fallback
// branch: the registry settled empty, with an error. `value`, when set, is
// the answer itself (a registry still loading, then answering).
type RegistryAnswer = {
  registry: {
    entries: Array<{ name: string; model_id: string; provider?: string }>;
    defaultEntry: { name: string; provider?: string } | null;
  };
  loading: boolean;
  error: string | null;
};
export const registryStub: {
  failed: boolean;
  value: RegistryAnswer | null;
} = { failed: false, value: null };
export const useAvailableModelsMock = () =>
  registryStub.value ??
  (registryStub.failed
    ? {
        registry: { entries: [], defaultEntry: null },
        loading: false,
        error: "HTTP 404",
      }
    : populatedRegistry);
const populatedRegistry = {
  registry: {
    entries: [
      {
        name: "claude-sonnet-4-6",
        model_id: "claude-sonnet-4-6",
        provider: "anthropic",
      },
    ],
    defaultEntry: { name: "claude-sonnet-4-6", provider: "anthropic" },
  },
  loading: false,
  error: null,
};

// Tests of the scrolled-up state set `isAtBottom` to false before rendering and
// put it back afterwards; `scrollToBottom` can be swapped for a spy.
export const stickToBottomStub = {
  isAtBottom: true,
  scrollToBottom: (): void => {},
};

export const useStickToBottomMock = () => ({
  scrollRef: { current: null },
  contentRef: { current: null },
  scrollToBottom: stickToBottomStub.scrollToBottom,
  isAtBottom: stickToBottomStub.isAtBottom,
});

export const useCollapseAgentActionsMock = () => ({
  value: true,
  setValue: () => {},
});
