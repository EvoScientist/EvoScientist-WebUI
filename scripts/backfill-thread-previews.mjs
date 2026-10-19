// One-shot backfill for thread sidebar labels.
//
// The WebUI's thread sidebar reads its title and description from precomputed
// keys in `thread.metadata` (`auto_title`, `preview`) so `/threads/search` can
// stay small — the raw response used to be tens of MB per page because it
// carried every thread's full `values.messages`. `useChat` writes these keys
// after each turn, but pre-existing threads have neither key set and would
// render blank until they get a new turn.
//
// This script seeds them once. For every thread missing either key, it fetches
// the full record (which contains `values.messages`), derives the two labels
// using the same rules as `deriveThreadMetadata` in `useThreads.ts`, and PATCHes
// the metadata with only the missing keys (so user renames + pinned flags +
// filter keys are preserved via read-merge-write).
//
// Usage (from repo root):
//   node scripts/backfill-thread-previews.mjs
//
// Env:
//   DEPLOYMENT_URL                 default http://127.0.0.1:$PORT
//   EVOSCIENTIST_LANGGRAPH_DEV_PORT default 6606
//   EVOSCIENTIST_GRAPH_ID           default EvoScientist (the chat graph)
//   LANGSMITH_API_KEY               optional; passed as X-Api-Key when set
//
// Safe to re-run: threads with both keys already set are skipped without a
// network write.

import { Client } from "@langchain/langgraph-sdk";

const PORT = process.env.EVOSCIENTIST_LANGGRAPH_DEV_PORT || "6606";
const DEPLOYMENT_URL = process.env.DEPLOYMENT_URL || `http://127.0.0.1:${PORT}`;
const API_KEY = process.env.LANGSMITH_API_KEY || "";
const GRAPH_ID = process.env.EVOSCIENTIST_GRAPH_ID || "EvoScientist";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const p of content) {
      if (p && typeof p === "object" && typeof p.text === "string") {
        out += p.text;
      }
    }
    return out;
  }
  return "";
}

function derive(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let autoTitle = null;
  let preview = null;
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    if (autoTitle === null && m.type === "human") {
      const t = textOf(m.content).trim();
      if (t) autoTitle = t.slice(0, 100);
    }
    if (preview === null && m.type === "ai") {
      const t = textOf(m.content).trim();
      if (t) preview = t.slice(0, 200);
    }
    if (autoTitle !== null && preview !== null) break;
  }
  return { autoTitle, preview };
}

async function main() {
  const client = new Client({
    apiUrl: DEPLOYMENT_URL,
    defaultHeaders: API_KEY ? { "X-Api-Key": API_KEY } : {},
  });

  // Every chat thread, whatever its folder or assistant: labels are per
  // thread.
  const metadataFilter = { graph_id: GRAPH_ID };

  console.log(
    `Backfilling against ${DEPLOYMENT_URL}  filter=${JSON.stringify(
      metadataFilter
    )}`
  );

  // Phase 1: scan every thread with a metadata-only select. Tiny payload; we
  // only need to know which threads are missing either derived key.
  const needsBackfill = [];
  let offset = 0;
  const pageSize = 100;
  let scanned = 0;
  while (true) {
    const page = await client.threads.search({
      limit: pageSize,
      offset,
      sortBy: "updated_at",
      sortOrder: "desc",
      metadata: metadataFilter,
      select: ["thread_id", "metadata"],
    });
    if (page.length === 0) break;
    scanned += page.length;
    for (const t of page) {
      const md = t.metadata || {};
      const hasAutoTitle =
        typeof md.auto_title === "string" && md.auto_title.trim().length > 0;
      const hasPreview =
        typeof md.preview === "string" && md.preview.trim().length > 0;
      if (!hasAutoTitle || !hasPreview) {
        needsBackfill.push({ id: t.thread_id, md, hasAutoTitle, hasPreview });
      }
    }
    offset += page.length;
  }
  console.log(
    `Scanned ${scanned}  needs backfill: ${
      needsBackfill.length
    }  already seeded: ${scanned - needsBackfill.length}`
  );

  // Phase 2: for each remaining thread, pull the full record (which contains
  // values.messages) and derive from that. Sequential so we don't hammer the
  // backend and get predictable progress output for a one-shot script.
  let updated = 0;
  let missed = 0;
  let errored = 0;
  for (const row of needsBackfill) {
    try {
      const t = await client.threads.get(row.id);
      const messages = (t?.values && t.values.messages) || [];
      const derived = derive(messages);
      const patch = {};
      if (derived.autoTitle && !row.hasAutoTitle) {
        patch.auto_title = derived.autoTitle;
      }
      if (derived.preview && !row.hasPreview) {
        patch.preview = derived.preview;
      }
      if (Object.keys(patch).length === 0) {
        missed += 1;
        console.log(`  ${row.id.slice(0, 8)}  no derivable text — skipped`);
        continue;
      }
      await client.threads.update(row.id, {
        metadata: { ...(t.metadata || {}), ...patch },
      });
      updated += 1;
      console.log(
        `  ${row.id.slice(0, 8)}  wrote ${Object.keys(patch).join(",")}`
      );
    } catch (e) {
      errored += 1;
      console.error(`  ${row.id.slice(0, 8)}  error: ${e?.message || e}`);
    }
  }

  console.log(
    `\nDone.  updated=${updated}  missed=${missed}  errored=${errored}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
