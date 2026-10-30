"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import type { Thread } from "@langchain/langgraph-sdk";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { timeBucketFor } from "@/lib/time";
import {
  useThreads,
  type ThreadItem,
  type ThreadScope,
} from "@/app/hooks/useThreads";
import { useRevalidateOn } from "@/app/hooks/useRevalidateOn";
import { dedupeThreads, matchesSearch } from "@/lib/threadLists";

const TIME_LABELS = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This Week",
  older: "Older",
} as const;

const PAGE_SIZE = 20;

/** How many pages a section reads by itself while none shows a thread. */
const AUTO_PAGES = 5;

/**
 * One section's threads (a project's, or those with no project): pinned
 * first, then by time, a page at a time. Threads in `exclude` show elsewhere
 * (Requiring Attention). Mounted only while its section is open, so a
 * collapsed section reads nothing.
 */
export function ThreadGroups({
  scope,
  status,
  search,
  exclude,
  now,
  revision,
  renderThread,
  emptyText,
}: {
  scope: ThreadScope;
  status?: Thread["status"];
  search: string;
  exclude: ReadonlySet<string>;
  now: Date;
  revision: number;
  renderThread: (thread: ThreadItem) => ReactNode;
  emptyText: string;
}) {
  const threads = useThreads({ scope, status, limit: PAGE_SIZE });
  useRevalidateOn(revision, threads.mutate);

  const shown = useMemo(
    () =>
      dedupeThreads(threads.data).filter(
        (t) => !exclude.has(t.id) && matchesSearch(t, search)
      ),
    [threads.data, exclude, search]
  );
  const pinned = shown.filter((t) => t.pinned);
  const grouped = useMemo(() => {
    const groups: Record<keyof typeof TIME_LABELS, ThreadItem[]> = {
      today: [],
      yesterday: [],
      week: [],
      older: [],
    };
    for (const thread of shown) {
      if (!thread.pinned) {
        groups[timeBucketFor(thread.updatedAt, now)].push(thread);
      }
    }
    return groups;
  }, [shown, now]);

  const isLoadingMore =
    threads.size > 0 && threads.data?.[threads.size - 1] == null;
  const hasMore = threads.data?.at(-1)?.full === true;

  // A section whose loaded pages show nothing (its threads are further
  // down, or all in Requiring Attention) reads a few more by itself.
  const { size, setSize } = threads;
  const fill =
    shown.length === 0 && hasMore && !isLoadingMore && size < AUTO_PAGES;
  useEffect(() => {
    if (fill) void setSize(size + 1);
  }, [fill, size, setSize]);

  if (threads.error) {
    return (
      <p className="px-2.5 py-2 text-xs text-red-600">
        Failed to load: {threads.error.message}
      </p>
    );
  }
  if (!threads.data) {
    return (
      <div
        aria-live="polite"
        className="space-y-2 px-1.5 py-1"
      >
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  return (
    <div className="pb-1">
      {shown.length === 0 && !fill && (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">
          {search.trim()
            ? "No research matches your search."
            : hasMore
            ? "None in the conversations read so far."
            : emptyText}
        </p>
      )}
      {pinned.length > 0 && (
        <div className="mb-1 flex flex-col gap-1">
          {pinned.map((thread) => renderThread(thread))}
        </div>
      )}
      {(Object.keys(TIME_LABELS) as Array<keyof typeof TIME_LABELS>).map(
        (group) =>
          grouped[group].length === 0 ? null : (
            <div
              key={group}
              className="mb-1"
            >
              <h5 className="m-0 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                {TIME_LABELS[group]}
              </h5>
              <div className="flex flex-col gap-1">
                {grouped[group].map((thread) => renderThread(thread))}
              </div>
            </div>
          )
      )}
      {hasMore && (
        <div className="flex justify-center py-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => threads.setSize(threads.size + 1)}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading…
              </>
            ) : (
              "Load More"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
