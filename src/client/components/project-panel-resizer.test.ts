import { describe, expect, it } from "vitest";

import { clampInspectorWidth, inspectorWidthBounds } from "./project-panel-resizer";

describe("project panel resizing", () => {
  it("keeps a useful console width on a wide desktop", () => {
    const bounds = inspectorWidthBounds(1_160);

    expect(bounds).toEqual({ max: 720, min: 260 });
    expect(clampInspectorWidth(510, bounds)).toBe(510);
  });

  it("collapses to the narrow inspector bound when desktop space is constrained", () => {
    const bounds = inspectorWidthBounds(520);

    expect(bounds).toEqual({ max: 220, min: 220 });
    expect(clampInspectorWidth(320, bounds)).toBe(220);
  });

  it("clamps pointer and keyboard requests to the current bounds", () => {
    const bounds = inspectorWidthBounds(900);

    expect(clampInspectorWidth(100, bounds)).toBe(bounds.min);
    expect(clampInspectorWidth(900, bounds)).toBe(bounds.max);
  });
});
