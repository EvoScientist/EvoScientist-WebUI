// @vitest-environment jsdom
//
// The Memory nav's badge counts the memory files changed since the user last
// looked. AutoSkills' own files under autoskills/ are left out (a draft's
// manifest, which every decision rewrites, and the processed marks a run or a
// revert writes): the drafts are announced on Research Skills.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySeenAt, setMemorySeenAt } from "@/lib/memoryActivity";
import { useMemoryActivity } from "./useMemoryActivity";

// What GET /api/memory lists: paths relative to the memory folder (POSIX)
// with their mtimes.
let entries: Array<{ path: string; mtime: number }> = [];

beforeEach(() => {
  localStorage.clear();
  entries = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ entries }),
      })
    )
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Lets the read under way answer: the mocked one is done before the next
 *  task. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Mounts the hook without a poll of its own and lets its first read
 *  answer. */
async function mount() {
  const view = renderHook(() =>
    useMemoryActivity({ intervalMs: 60 * 60 * 1000 })
  );
  await settle();
  return view;
}

async function readAgain(view: { result: { current: { refresh(): void } } }) {
  act(() => {
    view.result.current.refresh();
  });
  await settle();
}

const MANIFEST = "autoskills/proposals/data-cleaning/manifest.json";

describe("useMemoryActivity", () => {
  it("newer autoskills/ files don't raise the count; memory files still do", async () => {
    setMemorySeenAt(1_000);
    entries = [
      { path: "profile/USER_PROFILE.md", mtime: 500 },
      { path: MANIFEST, mtime: 2_000 },
      { path: "autoskills/processed/3f2a.json", mtime: 3_000 },
    ];
    const view = await mount();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(view.result.current.unseenCount).toBe(0);

    // A decision rewrites the manifest; a run writes another processed mark.
    entries = [
      { path: "profile/USER_PROFILE.md", mtime: 500 },
      { path: MANIFEST, mtime: 4_000 },
      { path: "autoskills/processed/3f2a.json", mtime: 3_000 },
      { path: "autoskills/processed/9b1c.json", mtime: 4_000 },
    ];
    await readAgain(view);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(view.result.current.unseenCount).toBe(0);

    // Memory files count, a folder named autoskills elsewhere too.
    entries = [
      ...entries,
      { path: "observations/obs-1.md", mtime: 3_500 },
      { path: "projects/autoskills/notes.md", mtime: 3_600 },
    ];
    await readAgain(view);
    expect(view.result.current.unseenCount).toBe(2);
  });

  it("a first run takes its baseline from the memory files, not from a newer autoskills/ file", async () => {
    entries = [
      { path: "profile/USER_PROFILE.md", mtime: 1_000 },
      { path: MANIFEST, mtime: 5_000 },
    ];
    const view = await mount();
    expect(getMemorySeenAt()).toBe(1_000);
    expect(view.result.current.unseenCount).toBe(0);

    // A memory file written after that baseline counts, though older than
    // the manifest.
    entries = [...entries, { path: "observations/obs-1.md", mtime: 3_000 }];
    await readAgain(view);
    expect(view.result.current.unseenCount).toBe(1);
  });
});
