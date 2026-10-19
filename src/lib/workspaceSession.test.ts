import { describe, expect, it } from "vitest";

import { readyWorkspace } from "@/test/mockWorkspace";
import { localFilesNotice } from "./workspaceSession";

describe("localFilesNotice", () => {
  const ready = readyWorkspace("/home/you/projA");

  it("shows nothing when this machine's folder is the backend's", () => {
    expect(
      localFilesNotice({
        ...ready,
        local: { dir: "/home/you/projA", sameFolder: true },
      })
    ).toBeNull();
    expect(localFilesNotice({ status: "legacy" })).toBeNull();
  });

  it("tells waiting apart from another folder and no local folder", () => {
    expect(localFilesNotice({ status: "pending" })).toMatch(/Connecting/);
    expect(localFilesNotice(ready)).toMatch(/no EvoScientist workspace/);
    expect(
      localFilesNotice({
        ...ready,
        local: { dir: "/home/you/other", sameFolder: false },
      })
    ).toMatch(/on the backend's machine/);
  });
});
