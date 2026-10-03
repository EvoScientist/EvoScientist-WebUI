// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileTextContent } from "./FileTextContent";

const highlights = vi.hoisted(() => ({ count: 0 }));
vi.mock("react-syntax-highlighter", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("react-syntax-highlighter")
  >();
  const Prism = (props: React.ComponentProps<typeof real.Prism>) => {
    highlights.count += 1;
    return <real.Prism {...props} />;
  };
  return { ...real, Prism };
});

describe("FileTextContent", () => {
  it("renders Markdown, code and empty files", () => {
    const { rerender, container } = render(
      <FileTextContent
        content={"# Title\n\nbody"}
        ext="md"
      />
    );
    expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
    rerender(
      <FileTextContent
        content="print(1)"
        ext="py"
      />
    );
    expect(container.querySelector("code")?.textContent).toContain("print");
    rerender(
      <FileTextContent
        content=""
        ext="py"
      />
    );
    expect(screen.getByText("File is empty")).toBeTruthy();
  });

  it("doesn't highlight again when only its parent re-renders", () => {
    // Every open tab re-renders on each refresh tick; highlighting a big
    // file again each time would block the page during a run.
    function Host({ tick }: { tick: number }) {
      return (
        <div data-tick={tick}>
          <FileTextContent
            content="print(1)"
            ext="py"
          />
        </div>
      );
    }
    highlights.count = 0;
    const { rerender } = render(<Host tick={0} />);
    rerender(<Host tick={1} />);
    rerender(<Host tick={2} />);
    expect(highlights.count).toBe(1);
  });
});
