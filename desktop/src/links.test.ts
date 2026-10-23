import { describe, expect, it } from "vitest";
import { classifyLink } from "./links";

describe("classifyLink", () => {
  const ui = "http://127.0.0.1:4718";
  it.each([
    ["http://127.0.0.1:4718/?thread=1", "app"],
    ["http://127.0.0.1:6174/docs", "browser"],
    ["https://github.com/EvoScientist", "browser"],
    ["mailto:someone@example.com", "browser"],
    ["file:///C:/Windows/system32", "block"],
    ["javascript:alert(1)", "block"],
    ["not a url", "block"],
  ])("%s goes to %s", (url, target) => {
    expect(classifyLink(url, ui)).toBe(target);
  });

  it("keeps nothing in the app before the UI has an origin", () => {
    expect(classifyLink("http://127.0.0.1:4718/", null)).toBe("browser");
  });
});
