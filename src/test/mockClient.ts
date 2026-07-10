// A stand-in for the `@langchain/langgraph-sdk` Client. useChat only reaches
// into `client.threads.get`, `client.threads.getState`, and
// `client.threads.updateState`, so we only mirror those. Everything else on
// the real Client is left off — a test that hits an unmocked method will
// throw with an obvious error rather than silently drift.

import { vi } from "vitest";
import type { Message } from "@langchain/langgraph-sdk";

export interface MockThreadState {
  next?: unknown[];
  tasks?: Array<{ interrupts?: unknown[] }>;
  values?: { messages?: Message[] };
}

export interface MockThreadRecord {
  metadata?: Record<string, unknown>;
  values?: { messages?: Message[] };
}

export class MockClient {
  private records = new Map<string, MockThreadRecord>();
  private states = new Map<string, MockThreadState>();

  setThreadRecord(id: string, record: MockThreadRecord): void {
    this.records.set(id, record);
  }

  setThreadState(id: string, state: MockThreadState): void {
    this.states.set(id, state);
  }

  threads = {
    get: vi.fn(async (id: string): Promise<MockThreadRecord> => {
      return this.records.get(id) ?? {};
    }),
    getState: vi.fn(async (id: string): Promise<MockThreadState> => {
      return (
        this.states.get(id) ?? {
          next: [],
          tasks: [],
          values: { messages: [] },
        }
      );
    }),
    updateState: vi.fn(async () => {}),
    patch: vi.fn(async () => {}),
  };
}

let activeClient: MockClient | null = null;

export function installMockClient(c: MockClient): void {
  activeClient = c;
}

export function clearMockClient(): void {
  activeClient = null;
}

export function getActiveMockClient(): MockClient {
  if (!activeClient) {
    throw new Error(
      "getActiveMockClient() called before installMockClient(new MockClient()) in beforeEach()."
    );
  }
  return activeClient;
}
