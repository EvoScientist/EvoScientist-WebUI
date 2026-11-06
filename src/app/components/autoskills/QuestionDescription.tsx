"use client";

import type { Question } from "@/app/components/autoskills/question";
import { DialogDescription } from "@/components/ui/dialog";

// An approval question's description: its sentences, then the files it
// installs unseen. All of it is the dialog's description, so a screen
// reader reads the files with the question.

export function QuestionDescription({ question }: { question: Question }) {
  const { description, files } = question;
  if (!files) return <DialogDescription>{description}</DialogDescription>;
  return (
    <DialogDescription asChild>
      <div className="space-y-2">
        {description && <p className="mb-0">{description}</p>}
        <p className="mb-0">{files.intro}</p>
        <ul className="m-0 list-none space-y-1 p-0">
          {files.groups.map((group, i) =>
            group.name === null ? (
              group.lines.map((line) => (
                <FileLine
                  key={`${i}\n${line}`}
                  line={line}
                />
              ))
            ) : (
              <li
                key={`${i}\n${group.name}`}
                className="mb-0"
              >
                <span className="break-words font-medium text-foreground">
                  {group.name}
                </span>
                <ul className="m-0 mt-0.5 list-none space-y-0.5 p-0 pl-3">
                  {group.lines.map((line) => (
                    <FileLine
                      key={line}
                      line={line}
                    />
                  ))}
                </ul>
              </li>
            )
          )}
        </ul>
        <p className="mb-0">{files.outro}</p>
      </div>
    </DialogDescription>
  );
}

function FileLine({ line }: { line: string }) {
  return <li className="mb-0 [overflow-wrap:anywhere]">{line}</li>;
}
