"use client";

import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import type { TodoItem } from "@/app/types/types";
import { cn } from "@/lib/utils";

interface PhasedTodoCardProps {
  todos: TodoItem[];
}

/**
 * Phased task list card. One row per todo:
 *
 *  ● Running Phase 1 initial scouting          (in_progress — brand + spinner)
 *  ○ Phase 2: Outline planning                 (pending)
 *  ✓ Phase 3: Per-chapter deep research (loop) (completed — success dot + strike)
 *
 * The status → row style mapping is deliberately simple. If todos start
 * carrying tags/subtasks/chapters we can grow the row component; for v1 the
 * deepagents `write_todos` output is flat.
 */
export function PhasedTodoCard({ todos }: PhasedTodoCardProps) {
  if (todos.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <ul className="flex flex-col gap-1.5">
        {todos.map((todo, index) => (
          <li
            key={`${todo.content}-${index}`}
            className="flex items-start gap-2"
          >
            <TodoStatusIcon status={todo.status} />
            <span
              className={cn(
                "text-sm leading-6",
                todo.status === "completed"
                  ? "text-muted-foreground line-through"
                  : todo.status === "in_progress"
                  ? "font-medium text-foreground"
                  : "text-muted-foreground"
              )}
            >
              {todo.status === "in_progress"
                ? `Running ${todo.content}`
                : todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TodoStatusIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return (
      <CheckCircle2
        className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]"
        aria-hidden="true"
      />
    );
  }
  if (status === "in_progress") {
    return (
      <Loader2
        className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--brand)]"
        aria-hidden="true"
      />
    );
  }
  return (
    <Circle
      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
  );
}
