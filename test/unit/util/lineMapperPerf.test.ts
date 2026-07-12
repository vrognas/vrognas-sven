import { describe, it, expect } from "vitest";
import { computeLineMapping } from "../../../src/util/lineMapper";

describe("computeLineMapping — large inputs", () => {
  it("shows no blame on a truly oversized diff core (no OOM, no misattribution)", () => {
    // 5000x5000 fully-distinct lines exceed the 4M dense-cell budget and have
    // no exact sparse anchors. Avoid both an OOM matrix and positional
    // misattribution: every base line stays unmapped.
    const N = 5000;
    const base = Array.from({ length: N }, (_, i) => `b${i}`);
    const working = Array.from({ length: N }, (_, i) => `w${i}`);

    const mapping = computeLineMapping(base, working);

    expect(mapping.get(1)).toBeUndefined();
    expect(mapping.get(N)).toBeUndefined();
  });

  it("keeps precise mapping for a large mostly-unchanged file", () => {
    // 3000 identical lines with a single modified line in the middle.
    // Prefix/suffix stripping shrinks the LCS work to the 1-line core.
    const N = 3000;
    const mid = Math.floor(N / 2); // 0-indexed changed line
    const base = Array.from({ length: N }, (_, i) => `line ${i} content`);
    const working = base.slice();
    working[mid] = "line 1500 content MODIFIED";

    const mapping = computeLineMapping(base, working);

    expect(mapping.get(1)).toBe(1); // unchanged prefix
    expect(mapping.get(mid + 1)).toBe(mid + 1); // modified line still maps
    expect(mapping.get(N)).toBe(N); // unchanged suffix
  });

  it("maps sparse survivors in an over-cap core", () => {
    const base = Array.from({ length: 7000 }, (_, i) => `body ${i}`);
    const kept = base.slice(1000, 3998);
    kept[1500] = "body 2500 MODIFIED";
    const working = ["INSERTED TOP", ...kept, "INSERTED BOTTOM"]; // 3000 lines

    const mapping = computeLineMapping(base, working);

    expect(mapping.get(1001)).toBe(2); // separate BASE/working offsets
    expect(mapping.get(2501)).toBe(1502); // modified line between anchors
    expect(mapping.get(3998)).toBe(2999);
    expect(mapping.get(1)).toBeUndefined(); // deleted region stays unmapped
  });

  it("keeps one-sided modified edge lines around sparse anchors", () => {
    const base = Array.from({ length: 2100 }, (_, i) => `body ${i}`);
    const working = base.slice();
    working[0] = "rewritten first";
    working[working.length - 1] = "rewritten last";

    const mapping = computeLineMapping(base, working);

    expect(mapping.get(1)).toBe(1);
    expect(mapping.get(base.length)).toBe(working.length);
  });

  it("prefers a long repeated LCS over one moved unique line", () => {
    const repeated = Array<string>(2000).fill("same");
    const base = ["moved", ...repeated];
    const working = [...repeated, "moved"];

    const mapping = computeLineMapping(base, working);

    expect(mapping.get(1)).toBeUndefined();
    expect(mapping.get(2)).toBe(1);
    expect(mapping.get(base.length)).toBe(working.length - 1);
  });

  it("maps a repeated oversized core changed at both edges", () => {
    const repeated = Array<string>(2000).fill("same");
    const base = ["old top", ...repeated, "old bottom"];
    const working = ["new top", ...repeated, "new bottom"];

    const mapping = computeLineMapping(base, working);

    expect(mapping.get(1)).toBe(1);
    expect(mapping.get(1001)).toBe(1001);
    expect(mapping.get(base.length)).toBe(working.length);
  });
});
