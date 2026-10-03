"use client";

import React from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { isMarkdownExt, LANGUAGE_MAP } from "@/lib/fileKinds";

/**
 * A text file's body: rendered Markdown, highlighted code, or "empty".
 * Memoised: open tabs re-render on every refresh tick, and highlighting a
 * large file again each time would block the page.
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
      <div className="flex items-center justify-center p-12">
        <p className="text-sm text-muted-foreground">File is empty</p>
      </div>
    );
  }
  if (isMarkdownExt(ext)) {
    return (
      <div className="p-4">
        <MarkdownContent content={content} />
      </div>
    );
  }
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
});
