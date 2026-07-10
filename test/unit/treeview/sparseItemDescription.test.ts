import { describe, it, expect } from "vitest";
import SparseItemNode from "../../../src/treeView/nodes/sparseItemNode";
import { ISparseItem } from "../../../src/common/types";

/**
 * Selective-download item descriptions use the same dot separators as
 * the repo/file history descriptions - not vertical lines.
 */
describe("sparse item description", () => {
  it("joins metadata with dots, not vertical lines", () => {
    const item = {
      name: "model.R",
      path: "WorkArea/model.R",
      kind: "file",
      isGhost: false,
      revision: "401",
      author: "alice",
      date: "2026-03-01T10:00:00.000000Z",
      size: 2048
    } as unknown as ISparseItem;
    const node = new SparseItemNode(item, "/ws", async () => []);

    const description = String(node.getTreeItem().description);

    expect(description).toContain("r401 · alice");
    expect(description).not.toContain("|");
  });
});
