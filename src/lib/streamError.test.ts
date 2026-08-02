import { describe, expect, it } from "vitest";
import { formatStreamError } from "@/app/hooks/useChat";

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
