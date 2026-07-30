import { describe, expect, it } from "vitest";

import { getNextTabIndex } from "./tab-navigation";

describe("getNextTabIndex", () => {
  it("wraps horizontal arrow navigation", () => {
    expect(getNextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(getNextTabIndex("ArrowRight", 2, 3)).toBe(0);
  });

  it("supports Home and End", () => {
    expect(getNextTabIndex("Home", 1, 3)).toBe(0);
    expect(getNextTabIndex("End", 1, 3)).toBe(2);
  });

  it("ignores unrelated keys and empty tab lists", () => {
    expect(getNextTabIndex("Enter", 0, 3)).toBeNull();
    expect(getNextTabIndex("ArrowRight", 0, 0)).toBeNull();
  });
});
