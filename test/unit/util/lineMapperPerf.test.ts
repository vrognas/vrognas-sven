import { describe, it, expect } from "vitest";
import { computeLineMapping } from "../../../src/util/lineMapper";

describe("computeLineMapping — large inputs", () => {
  it("shows no blame on a truly oversized diff core (no OOM, no misattribution)", () => {
    // 5000x5000 fully-distinct lines → product > MAX_LCS_PRODUCT (20M). The
    // gate must avoid both the OOM full DP matrix AND offset-based positional
    // mapping (which would attribute blame to the wrong lines): every base
    // line in the over-cap core is left unmapped (no blame) instead.
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
});
