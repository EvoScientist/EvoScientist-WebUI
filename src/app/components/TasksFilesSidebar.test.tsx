// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { FilesPopover } from "./TasksFilesSidebar";
import { renderWithFilePane } from "@/test/filePaneHarness";

describe("FilesPopover", () => {
  it("opens an agent file in the file pane", () => {
    const h = renderWithFilePane(<FilesPopover files={{ "plan.md": "x" }} />);
    fireEvent.click(screen.getByRole("button", { name: /plan\.md/ }));
    expect(h.pane().activeTab?.id).toBe("state:plan.md");
  });
});
