import { describe, expect, it } from "vitest";

import { deriveProjectActivity } from "./project-activity";

describe("deriveProjectActivity", () => {
  it("keeps a running Preview separate from exclusive Project activity", () => {
    expect(
      deriveProjectActivity({
        previewActive: true,
        previewStarting: false,
        runActive: false,
        terminalActive: false,
      }),
    ).toEqual({ exclusive: "idle", preview: "running" });
  });

  it("treats Preview startup as exclusive activity", () => {
    expect(
      deriveProjectActivity({
        previewActive: true,
        previewStarting: true,
        runActive: false,
        terminalActive: false,
      }),
    ).toEqual({ exclusive: "preview_starting", preview: "starting" });
  });

  it("uses the most restrictive active operation when callbacks overlap briefly", () => {
    expect(
      deriveProjectActivity({
        previewActive: true,
        previewStarting: true,
        runActive: true,
        terminalActive: true,
      }),
    ).toEqual({ exclusive: "run", preview: "starting" });
  });
});
