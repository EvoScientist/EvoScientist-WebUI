import useSWRInfinite from "swr/infinite";
import type { Thread } from "@langchain/langgraph-sdk";
import { Client } from "@langchain/langgraph-sdk";
import { getConfig } from "@/lib/config";

export interface ThreadItem {
  id: string;
  updatedAt: Date;
  status: Thread["status"];
  title: string;
  description: string;
  assistantId?: string;
}

const DEFAULT_PAGE_SIZE = 20;

export function useThreads(props: {
  status?: Thread["status"];
  limit?: number;
}) {
  const pageSize = props.limit || DEFAULT_PAGE_SIZE;

  return useSWRInfinite(
    (pageIndex: number, previousPageData: ThreadItem[] | null) => {
      const config = getConfig();
      const apiKey =
        config?.langsmithApiKey ||
        process.env.NEXT_PUBLIC_LANGSMITH_API_KEY ||
        "";

      if (!config) {
        return null;
      }

      // If the previous page returned no items, we've reached the end
      if (previousPageData && previousPageData.length === 0) {
        return null;
      }

      return {
        kind: "threads" as const,
        pageIndex,
        pageSize,
        deploymentUrl: config.deploymentUrl,
        assistantId: config.assistantId,
        apiKey,
        status: props?.status,
      };
    },
    async ({
      deploymentUrl,
      assistantId,
      apiKey,
      status,
      pageIndex,
      pageSize,
    }: {
      kind: "threads";
      pageIndex: number;
      pageSize: number;
      deploymentUrl: string;
      assistantId: string;
      apiKey: string;
      status?: Thread["status"];
    }) => {
      const client = new Client({
        apiUrl: deploymentUrl,
        defaultHeaders: apiKey ? { "X-Api-Key": apiKey } : {},
      });

      // Always scope the thread list to the selected assistant so we never
      // show threads spawned by async sub-agents (e.g. writing-agent,
      // data-analysis-agent) that share the same deployment store.
      //
      // Every thread carries both `graph_id` (the graph name) and
      // `assistant_id` (a deterministic UUID per graph) in its metadata.
      // A deployed UUID is matched against `assistant_id`; a graph name
      // (the local-dev case, e.g. "EvoScientist") is matched against
      // `graph_id`.
      const isUUID =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          assistantId
        );
      const metadata = isUUID
        ? { assistant_id: assistantId }
        : { graph_id: assistantId };

      const threads = await client.threads.search({
        limit: pageSize,
        offset: pageIndex * pageSize,
        sortBy: "updated_at" as const,
        sortOrder: "desc" as const,
        status,
        metadata,
      });

      return threads.map((thread): ThreadItem => {
        let title = "Untitled Thread";
        let description = "";

        try {
          if (thread.values && typeof thread.values === "object") {
            const values = thread.values as any;
            const firstHumanMessage = values.messages.find(
              (m: any) => m.type === "human"
            );
            if (firstHumanMessage?.content) {
              const content =
                typeof firstHumanMessage.content === "string"
                  ? firstHumanMessage.content
                  : firstHumanMessage.content[0]?.text || "";
              title = content.slice(0, 50) + (content.length > 50 ? "..." : "");
            }
            const firstAiMessage = values.messages.find(
              (m: any) => m.type === "ai"
            );
            if (firstAiMessage?.content) {
              const content =
                typeof firstAiMessage.content === "string"
                  ? firstAiMessage.content
                  : firstAiMessage.content[0]?.text || "";
              description = content.slice(0, 100);
            }
          }
        } catch {
          // Fallback to thread ID
          title = `Thread ${thread.thread_id.slice(0, 8)}`;
        }

        // A user-set custom title (stored in metadata via rename) always wins.
        const customTitle = (
          thread.metadata as Record<string, unknown> | undefined
        )?.title;
        if (typeof customTitle === "string" && customTitle.trim()) {
          title = customTitle.trim();
        }

        return {
          id: thread.thread_id,
          updatedAt: new Date(thread.updated_at),
          status: thread.status,
          title,
          description,
          assistantId,
        };
      });
    },
    {
      revalidateFirstPage: true,
      revalidateOnFocus: true,
    }
  );
}

// --- Thread mutations (used by the thread list's rename / delete actions) ---

function makeThreadsClient(): Client | null {
  const config = getConfig();
  if (!config) return null;
  const apiKey =
    config.langsmithApiKey || process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "";
  return new Client({
    apiUrl: config.deploymentUrl,
    defaultHeaders: apiKey ? { "X-Api-Key": apiKey } : {},
  });
}

/** Permanently delete a thread. Throws if no deployment is configured. */
export async function deleteThread(id: string): Promise<void> {
  const client = makeThreadsClient();
  if (!client) throw new Error("No EvoScientist deployment configured.");
  await client.threads.delete(id);
}

/**
 * Rename a thread by storing a custom title in its metadata. `update` PATCHes
 * (merges) metadata, so the `graph_id` / `assistant_id` keys the list relies on
 * for filtering are preserved.
 */
export async function renameThread(id: string, title: string): Promise<void> {
  const client = makeThreadsClient();
  if (!client) throw new Error("No EvoScientist deployment configured.");
  await client.threads.update(id, { metadata: { title } });
}
