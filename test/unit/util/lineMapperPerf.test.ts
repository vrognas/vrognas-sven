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

  it("keeps a fully rewritten over-cap core when context brackets it", () => {
    const N = 4472;
    const base = [
      "HEAD",
      ...Array.from({ length: N }, (_, i) => `old ${i}`),
      "TAIL"
    ];
    const working = [
      "HEAD",
      ...Array.from({ length: N }, (_, i) => `new ${i}`),
      "TAIL"
    ];

    const mapping = computeLineMapping(base, working);

    expect(mapping.get(2)).toBe(2);
    expect(mapping.get(N + 1)).toBe(N + 1);
    expect(
      [...mapping.values()].filter(line => line !== undefined)
    ).toHaveLength(N + 2);
  });

  it("keeps an exact empty sparse LCS above the trace estimate cap", () => {
    const N = 131_579;
    const base = [
      "HEAD",
      ...Array.from({ length: N }, (_, i) => `old ${i}`),
      "TAIL"
    ];
    const working = [
      "HEAD",
      ...Array.from({ length: N }, (_, i) => `new ${i}`),
      "TAIL"
    ];

    const mapping = computeLineMapping(base, working);

    expect(mapping.get(2)).toBe(2);
    expect(mapping.get(N + 1)).toBe(N + 1);
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

  it("keeps repeated block attribution at the linear work boundary", () => {
    const blockLength = 2236;
    const base = [
      ...Array<string>(blockLength).fill("A"),
      ...Array<string>(blockLength).fill("B")
    ];
    const working = [
      ...Array<string>(blockLength).fill("B"),
      ...Array<string>(blockLength).fill("A")
    ];

    const mapping = computeLineMapping(base, working);

    expect(mapping.get(1)).toBeUndefined();
    expect(mapping.get(blockLength + 1)).toBe(1);
    expect(mapping.get(blockLength * 2)).toBe(blockLength);
    expect(
      [...mapping.values()].filter(value => value !== undefined)
    ).toHaveLength(blockLength);
  });

  it("keeps a long repeated LCS ahead of a moved unique sparse anchor", () => {
    const repeated = Array<string>(5000).fill("same");
    const base = ["D", ...repeated, "ax"];
    const working = [...repeated, "D"];

    const mapping = computeLineMapping(base, working);

    expect(mapping.get(1)).toBeUndefined();
    expect(mapping.get(2)).toBe(1);
    expect(mapping.get(5001)).toBe(5000);
    expect(mapping.get(5002)).toBe(5001);
  });

  it("keeps dense attribution across linear-space tie cases", () => {
    const trailingMove = computeLineMapping(
      ["B", ...Array<string>(1998).fill("C")],
      [...Array<string>(1999).fill("C"), "B"]
    );
    expect(trailingMove.get(1)).toBe(1);
    expect(trailingMove.get(2)).toBe(2);

    const leadingMove = computeLineMapping(
      [...Array<string>(1999).fill("A"), "X"],
      ["B", ...Array<string>(1998).fill("A"), "Y"]
    );
    expect(leadingMove.get(1)).toBe(1);
    expect(leadingMove.get(2)).toBe(2);
    expect(leadingMove.get(1999)).toBe(1999);
    expect(leadingMove.get(2000)).toBe(2000);
  });

  it("rejects a crossing unique anchor when bounded exact work is exhausted", () => {
    const repeated = Array<string>(5000).fill("same");
    const removed = Array.from({ length: 2500 }, (_, i) => `old ${i}`);
    const inserted = Array.from({ length: 2500 }, (_, i) => `new ${i}`);
    const base = ["moved", ...repeated, ...removed];
    const working = [...inserted, ...repeated, "moved"];

    const mapping = computeLineMapping(base, working);

    expect(mapping.get(1)).toBeUndefined();
  });

  it("keeps the unchanged body when a unique header block moves past the trace cap", () => {
    const lineCount = 4472;
    const movedCount = 236;
    const header = Array.from({ length: movedCount }, (_, i) => `header ${i}`);
    const body = Array.from(
      { length: lineCount - movedCount },
      (_, i) => `body ${i}`
    );

    const mapping = computeLineMapping(
      [...header, ...body],
      [...body, ...header]
    );

    expect(mapping.get(1)).toBeUndefined();
    expect(mapping.get(movedCount + 1)).toBe(1);
    expect(mapping.get(lineCount)).toBe(body.length);
    expect(
      [...mapping.values()].filter(value => value !== undefined)
    ).toHaveLength(body.length);
  });

  it("keeps the unchanged body past the checkpoint work cap", () => {
    const lineCount = 4472;
    const movedCount = 655;
    const header = Array.from({ length: movedCount }, (_, i) => `header ${i}`);
    const body = Array.from(
      { length: lineCount - movedCount },
      (_, i) => `body ${i}`
    );

    const mapping = computeLineMapping(
      [...header, ...body],
      [...body, ...header]
    );

    for (let baseLine = 1; baseLine <= movedCount; baseLine++) {
      expect(mapping.get(baseLine)).toBeUndefined();
    }
    for (let bodyOffset = 0; bodyOffset < body.length; bodyOffset++) {
      expect(mapping.get(movedCount + bodyOffset + 1)).toBe(bodyOffset + 1);
    }
  });

  it("keeps a sparse block move when one shared line repeats", () => {
    const lineCount = 4472;
    const movedCount = 655;
    const header = Array.from({ length: movedCount }, (_, i) => `header ${i}`);
    header[1] = header[0]!;
    const body = Array.from(
      { length: lineCount - movedCount },
      (_, i) => `body ${i}`
    );

    const mapping = computeLineMapping(
      [...header, ...body],
      [...body, ...header]
    );

    for (let baseLine = 1; baseLine <= movedCount; baseLine++) {
      expect(mapping.get(baseLine)).toBeUndefined();
    }
    for (let bodyOffset = 0; bodyOffset < body.length; bodyOffset++) {
      expect(mapping.get(movedCount + bodyOffset + 1)).toBe(bodyOffset + 1);
    }
  });

  it("uses remaining sparse budgets above 100k match pairs", () => {
    const lineCount = 4472;
    const movedCount = 655;
    const repeatedCount = 310;
    const header = [
      ...Array<string>(repeatedCount).fill("repeat"),
      ...Array.from(
        { length: movedCount - repeatedCount },
        (_, i) => `header ${i}`
      )
    ];
    const body = Array.from(
      { length: lineCount - movedCount },
      (_, i) => `body ${i}`
    );

    const mapping = computeLineMapping(
      [...header, ...body],
      [...body, ...header]
    );

    expect(mapping.get(movedCount + 1)).toBe(1);
    expect(mapping.get(lineCount)).toBe(body.length);
    expect(
      [...mapping.values()].filter(value => value !== undefined)
    ).toHaveLength(body.length);
  });

  it("keeps contextual rewrites from an exact sparse LCS", () => {
    const header = Array.from({ length: 655 }, (_, i) => `header ${i}`);
    const before = Array.from({ length: 1858 }, (_, i) => `before ${i}`);
    const baseChanges = Array.from({ length: 100 }, (_, i) => `old ${i}`);
    const workChanges = Array.from({ length: 101 }, (_, i) => `new ${i}`);
    const after = Array.from({ length: 1859 }, (_, i) => `after ${i}`);

    const mapping = computeLineMapping(
      [...header, ...before, ...baseChanges, ...after],
      [...before, ...workChanges, ...after, ...header]
    );
    const firstChange = header.length + before.length + 1;
    const firstAfter = firstChange + baseChanges.length;

    expect(mapping.get(firstChange)).toBe(before.length + 1);
    expect(mapping.get(firstChange + baseChanges.length - 1)).toBe(
      before.length + baseChanges.length
    );
    expect(mapping.get(firstAfter)).toBe(
      before.length + workChanges.length + 1
    );
  });

  it("keeps over-cap contextual rewrites from an exact sparse LCS", () => {
    const header = Array.from({ length: 655 }, (_, i) => `header ${i}`);
    const before = Array.from({ length: 1858 }, (_, i) => `before ${i}`);
    const baseChanges = Array.from({ length: 2100 }, (_, i) => `old ${i}`);
    const workChanges = Array.from({ length: 2101 }, (_, i) => `new ${i}`);
    const after = Array.from({ length: 1859 }, (_, i) => `after ${i}`);

    const mapping = computeLineMapping(
      [...header, ...before, ...baseChanges, ...after],
      [...before, ...workChanges, ...after, ...header]
    );
    const firstChange = header.length + before.length + 1;
    const firstAfter = firstChange + baseChanges.length;

    expect(mapping.get(firstChange)).toBe(before.length + 1);
    expect(mapping.get(firstChange + baseChanges.length - 1)).toBe(
      before.length + baseChanges.length
    );
    expect(mapping.get(firstAfter)).toBe(
      before.length + workChanges.length + 1
    );
  });

  it("keeps dense duplicate attribution in a sparse LCS", () => {
    const lineCount = 4472;
    const movedCount = 655;
    const header = Array.from({ length: movedCount }, (_, i) => `header ${i}`);
    const tail = Array.from(
      { length: lineCount - movedCount - 2 },
      (_, i) => `tail ${i}`
    );

    const laterBase = computeLineMapping(
      [...header, "same", "same", ...tail],
      ["same", ...tail, ...header]
    );
    expect(laterBase.get(movedCount + 1)).toBeUndefined();
    expect(laterBase.get(movedCount + 2)).toBe(1);
    expect(laterBase.get(movedCount + 3)).toBe(2);

    const laterWorking = computeLineMapping(
      [...header, "same", ...tail],
      ["same", "same", ...tail, ...header]
    );
    expect(laterWorking.get(movedCount + 1)).toBe(2);
    expect(laterWorking.get(movedCount + 2)).toBe(3);
  });

  it("keeps dense tie attribution in a one-to-one sparse LCS", () => {
    const lineCount = 4472;
    const movedCount = 655;
    const header = Array.from({ length: movedCount }, (_, i) => `header ${i}`);
    const tail = Array.from(
      { length: lineCount - movedCount - 2 },
      (_, i) => `tail ${i}`
    );

    const mapping = computeLineMapping(
      [...header, "one", "zero", ...tail],
      ["zero", "one", ...tail, ...header]
    );

    expect(mapping.get(movedCount + 1)).toBeUndefined();
    expect(mapping.get(movedCount + 2)).toBe(1);
    expect(mapping.get(movedCount + 3)).toBe(3);
    expect(mapping.get(lineCount)).toBe(tail.length + 2);
  });
});
