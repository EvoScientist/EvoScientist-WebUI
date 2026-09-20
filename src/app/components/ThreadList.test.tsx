// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ThreadItem } from "@/app/hooks/useThreads";

vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: () => react.useState<string | null>(null),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("@/app/hooks/useMemoryActivity", () => ({
  useMemoryActivity: () => ({ unseenCount: 0, markSeen: vi.fn() }),
}));

const threadFixtures: ThreadItem[] = [
  {
    id: "t-1",
    updatedAt: new Date(),
    status: "idle",
    title: "Protein folding survey",
    description: "latest reply",
    pinned: false,
    needsUserInput: false,
  },
  {
    id: "t-2",
    updatedAt: new Date(),
    status: "idle",
    title: "Pinned baseline run",
    description: "latest reply",
    pinned: true,
    needsUserInput: false,
  },
];

const pinThread = vi.fn(async (..._args: unknown[]) => {});
const exportThread = vi.fn(async (..._args: unknown[]) => {});
const mutate = vi.fn();

vi.mock("@/app/hooks/useThreads", () => ({
  useThreads: () => ({
    data: [threadFixtures],
    size: 1,
    setSize: vi.fn(),
    mutate,
    isLoading: false,
    error: undefined,
  }),
  deleteThread: vi.fn(async () => {}),
  renameThread: vi.fn(async () => {}),
  pinThread: (...args: unknown[]) => pinThread(...args),
  exportThread: (...args: unknown[]) => exportThread(...args),
}));

import { ThreadList } from "./ThreadList";

// On touch widths the four per-thread icons collapse into one "⋯" menu so the
// title keeps the row. jsdom applies no CSS, so both the desktop toolbar and the
// menu trigger are in the DOM here; the menu is addressed by its own roles.
describe("ThreadList per-thread actions menu", () => {
  beforeAll(() => {
    // Radix Popper measures its anchor; jsdom has no ResizeObserver.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  beforeEach(() => {
    pinThread.mockClear();
    exportThread.mockClear();
  });

  const openMenu = (title: string) => {
    const trigger = screen.getByRole("button", {
      name: `Actions for "${title}"`,
    });
    fireEvent.keyDown(trigger, { key: "Enter" });
    return trigger;
  };

  // Every test closes the dialog it opens. Unmounting with one still open leaks
  // into the next test in this file: the dialog that test opens from the menu is
  // gone again before it can be queried (passes alone, fails in sequence).
  const closeDialog = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  };

  it("offers pin, rename, export and delete from one trigger", async () => {
    render(<ThreadList onThreadSelect={vi.fn()} />);
    const trigger = openMenu("Protein folding survey");

    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Pin",
      "Rename",
      "Export JSON",
      "Delete",
    ]);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("labels the pin item by the thread's pinned state", async () => {
    render(<ThreadList onThreadSelect={vi.fn()} />);
    openMenu("Pinned baseline run");

    expect(await screen.findByRole("menuitem", { name: "Unpin" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull();
  });

  it("pins and exports through the same handlers as the toolbar", async () => {
    render(<ThreadList onThreadSelect={vi.fn()} />);

    openMenu("Protein folding survey");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(pinThread).toHaveBeenCalledWith("t-1", true));

    openMenu("Protein folding survey");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Export JSON" })
    );
    await waitFor(() =>
      expect(exportThread).toHaveBeenCalledWith("t-1", "Protein folding survey")
    );
  });

  it("opens the rename dialog prefilled with the title", async () => {
    render(<ThreadList onThreadSelect={vi.fn()} />);
    openMenu("Protein folding survey");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    expect(await screen.findByText("Rename research")).toBeTruthy();
    expect(
      (screen.getByPlaceholderText("Enter a title…") as HTMLInputElement).value
    ).toBe("Protein folding survey");
    await closeDialog();
  });

  // The menu item that opened the dialog is unmounted by the time it closes, so
  // Radix has nothing to restore focus to and would drop it on <body>.
  it.each(["Rename", "Delete"])(
    "returns focus to the trigger when the %s dialog is cancelled",
    async (item) => {
      render(<ThreadList onThreadSelect={vi.fn()} />);
      const trigger = openMenu("Protein folding survey");
      fireEvent.click(await screen.findByRole("menuitem", { name: item }));

      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.activeElement).toBe(trigger);
      });
    }
  );

  it("opens the delete confirmation and never selects the thread", async () => {
    const onThreadSelect = vi.fn();
    render(<ThreadList onThreadSelect={onThreadSelect} />);
    openMenu("Protein folding survey");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(onThreadSelect).not.toHaveBeenCalled();
    await closeDialog();
  });
});
