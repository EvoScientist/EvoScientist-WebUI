import { describe, expect, it } from "vitest";
import {
  formatStreamError,
  isModelError,
  isRunFolderMismatchError,
} from "@/lib/streamError";

describe("isRunFolderMismatchError", () => {
  it.each([
    "RunFolderMismatchError",
    "ProjectNotServedError",
    "NoProjectError",
  ])("matches a %s by name and in a runs.wait message", (name) => {
    expect(
      isRunFolderMismatchError(Object.assign(new Error("refused"), { name }))
    ).toBe(true);
    expect(isRunFolderMismatchError(new Error(`${name}: refused`))).toBe(true);
  });

  it("does not match other run errors", () => {
    expect(
      isRunFolderMismatchError(
        Object.assign(new Error("boom"), { name: "GraphRecursionError" })
      )
    ).toBe(false);
    expect(isRunFolderMismatchError(new Error("Run failed."))).toBe(false);
  });
});

describe("formatStreamError", () => {
  it("renders the provider error envelope with status and code", () => {
    expect(
      formatStreamError({
        error: "RateLimitError",
        class: "openai.RateLimitError",
        message: "You exceeded your current quota",
        provider: "openai",
        status_code: 429,
        code: "insufficient_quota",
        request_id: "req_123",
      })
    ).toBe(
      "RateLimitError: You exceeded your current quota (openai · 429 · insufficient_quota) [req_123]"
    );
  });

  it("renders a minimal envelope without optional fields", () => {
    expect(
      formatStreamError({
        error: "APIConnectionError",
        message: "Connection refused",
        provider: "anthropic",
      })
    ).toBe("APIConnectionError: Connection refused (anthropic)");
  });

  it("keeps legacy StreamError handling", () => {
    expect(formatStreamError({ name: "GraphError", message: "boom" })).toBe(
      "GraphError: boom"
    );
    expect(formatStreamError("raw failure")).toBe("raw failure");
    expect(formatStreamError(undefined)).toBe("Run failed.");
  });
});

describe("isModelError", () => {
  it("matches the provider envelope and an unknown model", () => {
    expect(
      isModelError({
        error: "RateLimitError",
        message: "insufficient credits",
        provider: "openai",
      })
    ).toBe(true);
    expect(
      isModelError(
        Object.assign(new Error("bare name"), { name: "UnknownModelError" })
      )
    ).toBe(true);
    expect(isModelError(new Error("UnknownModelError: bare name"))).toBe(true);
  });

  it("does not match a tool or stream failure", () => {
    expect(
      isModelError(
        Object.assign(new Error("boom"), { name: "GraphRecursionError" })
      )
    ).toBe(false);
    expect(isModelError(new Error("network error"))).toBe(false);
    expect(isModelError({ message: "x", provider: "" })).toBe(false);
  });
});
