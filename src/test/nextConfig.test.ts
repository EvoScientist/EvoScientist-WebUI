import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

// The server's own folder is not a place to write to. In the desktop app it
// is inside the signed app bundle, and on macOS one file added there breaks
// the signature's seal (the system then reports the app as modified). In the
// npm package it is the install folder.
describe("next.config", () => {
  it("keeps the server's page cache in memory, off the disk", () => {
    expect(nextConfig.experimental?.isrFlushToDisk).toBe(false);
  });
});
