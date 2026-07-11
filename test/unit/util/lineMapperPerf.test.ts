import { describe, it, expect } from "vitest";
import { computeLineMapping } from "../../../src/util/lineMapper";

describe("computeLineMapping — large inputs", () => {
  it("degrades to a positional mapping on oversized diffs (no OOM)", () => {
    // 2100x2100 fully-distinct lines → product > MAX_LCS_PRODUCT (4M).
    // Without the gate this fills a full DP matrix and the precise result
    // leaves unmatched base lines undefined; the gate maps them positionally.
    const N = 2100;
    const base = Array.from({ length: N }, (_, i) => `b${i}`);
    const working = Array.from({ length: N }, (_, i) => `w${i}`);

    const mapping = computeLineMapping(base, working);

    expect(mapping.get(1)).toBe(1);
    expect(mapping.get(N)).toBe(N);
  });

  it("keeps precise mapping for a large mostly-unchanged file", () => {
    // 3000 identical lines with a single modified line in the middle.
    // Prefix/suffix stripping shrinks the LCS work to the 1-line core, and
    // the bracketed-context flag still detects it as a modification.
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
});
