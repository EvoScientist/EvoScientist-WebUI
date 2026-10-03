"use client";

import React, { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { isMarkdownExt, LANGUAGE_MAP } from "@/lib/fileKinds";
import { cn } from "@/lib/utils";

// Scripts run, links may open a new tab; no allow-same-origin, so the page
// gets an opaque origin and can't read the app's storage or call its file
// APIs, and it can't navigate the app or submit forms.
const PAGE_SANDBOX =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox";

function Code({ content, ext }: { content: string; ext: string }) {
  return (
    <SyntaxHighlighter
      language={LANGUAGE_MAP[ext] || "text"}
      style={oneDark}
      customStyle={{ margin: 0, borderRadius: "0.5rem", fontSize: "0.875rem" }}
      showLineNumbers
      wrapLines={true}
      lineProps={{ style: { whiteSpace: "pre-wrap" } }}
    >
      {content}
    </SyntaxHighlighter>
  );
}

function Scrolling({ children }: { children: React.ReactNode }) {
  return (
    <ScrollArea className="h-full rounded-md bg-[var(--color-surface)]">
      <div className="p-4">{children}</div>
    </ScrollArea>
  );
}

/**
 * An HTML file as the page it describes, or its source. Pages that pull in
 * files next to them (style.css, images) show without those: the preview
 * gets the one file.
 */
function HtmlPage({ content }: { content: string }) {
  const [view, setView] = useState<"page" | "source">("page");
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-0.5 self-start rounded-md bg-muted p-0.5 text-xs">
        {(
          [
            ["page", "Preview"],
            ["source", "Source"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setView(value)}
            aria-pressed={view === value}
            className={cn(
              "rounded px-2 py-0.5 font-medium transition-colors max-sm:min-h-11 max-sm:px-3",
              view === value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {view === "page" ? (
          // White like a browser tab: a page that sets no background would
          // otherwise draw black text on the dark theme's surface.
          <iframe
            title="Page preview"
            sandbox={PAGE_SANDBOX}
            srcDoc={content}
            referrerPolicy="no-referrer"
            className="h-full w-full rounded-md border border-border bg-white"
          />
        ) : (
          <Scrolling>
            <Code
              content={content}
              ext="html"
            />
          </Scrolling>
        )}
      </div>
    </div>
  );
}

/**
 * A text file's body, filling its container: rendered Markdown, an HTML page
 * (with its source a click away), highlighted code, or "empty".
 * Memoised: open tabs re-render on every refresh tick, and highlighting a
 * large file again (or reloading a page) each time would block the page or
 * throw away what the user did in it.
 */
export const FileTextContent = React.memo(function FileTextContent({
  content,
  ext,
}: {
  content: string;
  ext: string;
}) {
  if (!content) {
    return (
      <Scrolling>
        <div className="flex items-center justify-center p-12">
          <p className="text-sm text-muted-foreground">File is empty</p>
        </div>
      </Scrolling>
    );
  }
  if (ext === "html") {
    return <HtmlPage content={content} />;
  }
  if (isMarkdownExt(ext)) {
    return (
      <Scrolling>
        <div className="p-4">
          <MarkdownContent content={content} />
        </div>
      </Scrolling>
    );
  }
  return (
    <Scrolling>
      <Code
        content={content}
        ext={ext}
      />
    </Scrolling>
  );
});
