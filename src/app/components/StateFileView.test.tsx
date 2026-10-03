// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StateFileView } from "./StateFileView";
import type {
  ChatFilesBridge,
  Draft,
  DraftStore,
} from "@/providers/filePaneContext";

function draftStore(): DraftStore {
  const m = new Map<string, Draft>();
  return {
    get: (id) => m.get(id),
    set: (id, d) => {
      if (d === undefined) m.delete(id);
      else m.set(id, d);
    },
  };
}

const chat = (over: Partial<ChatFilesBridge> = {}): ChatFilesBridge => ({
  threadId: "t1",
  files: { "plan.md": "step one", "other.md": "x" },
  setFiles: vi.fn(async () => {}),
  editDisabled: false,
  ...over,
});

type Props = React.ComponentProps<typeof StateFileView>;

const view = (over: Partial<Props> = {}) => {
  const props: Props = {
    tabId: "state:plan.md",
    path: "plan.md",
    chat: chat(),
    drafts: draftStore(),
    onDirtyChange: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<StateFileView {...props} />);
  return props;
};

describe("StateFileView", () => {
  it("shows the file from the conversation", () => {
    view();
    expect(screen.getByText("step one")).toBeTruthy();
  });

  it("saves edits back into the conversation's files", async () => {
    const props = view();
    fireEvent.click(screen.getByRole("button", { name: "Edit file" }));
    fireEvent.change(screen.getByLabelText("File content"), {
      target: { value: "step two" },
    });
    await waitFor(() =>
      expect(props.onDirtyChange).toHaveBeenLastCalledWith(
        "state:plan.md",
        true
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(props.chat!.setFiles).toHaveBeenCalledWith({
        "plan.md": "step two",
        "other.md": "x",
      })
    );
    // The chat's files don't refetch after a save: show what was saved.
    expect(await screen.findByText("step two")).toBeTruthy();
    expect(screen.queryByText("step one")).toBeNull();
  });

  it("follows the conversation again once its files change", async () => {
    const props: React.ComponentProps<typeof StateFileView> = {
      tabId: "state:plan.md",
      path: "plan.md",
      chat: chat(),
      drafts: draftStore(),
      onDirtyChange: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<StateFileView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit file" }));
    fireEvent.change(screen.getByLabelText("File content"), {
      target: { value: "step two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("step two")).toBeTruthy();
    rerender(
      <StateFileView
        {...props}
        chat={chat({ files: { "plan.md": "step three", "other.md": "x" } })}
      />
    );
    expect(screen.getByText("step three")).toBeTruthy();
  });

  it("can't be edited while the agent is running", () => {
    view({ chat: chat({ editDisabled: true }) });
    expect(
      (screen.getByRole("button", { name: "Edit file" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("says when the file left the conversation", () => {
    const props = view({ chat: chat({ files: {} }) });
    expect(
      screen.getByText("This file is no longer in the conversation.")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(props.onClose).toHaveBeenCalledWith("state:plan.md");
  });

  it("waits for the conversation when the chat isn't open", () => {
    view({ chat: null });
    expect(
      screen.getByText("Open the conversation this file belongs to.")
    ).toBeTruthy();
  });
});
