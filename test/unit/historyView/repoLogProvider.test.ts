import { describe, it, expect } from "vitest";
import * as path from "path";
import { parseSvnLog } from "../../../src/parser/logParser";

/**
 * E2E Tests: Revision Expansion (v2.17.137 bug fix)
 * Tests full flow: XML → parser → path content accessible
 */
describe("RepoLogProvider - Revision Expansion E2E", () => {
  it("expands revision showing multiple changed files", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<log>
  <logentry revision="126">
    <author>testuser</author>
    <date>2025-11-15T10:00:00.000000Z</date>
    <msg>Multiple changes</msg>
    <paths>
      <path kind="file" action="M">/trunk/src/file.txt</path>
      <path kind="dir" action="A">/trunk/newdir</path>
      <path kind="file" action="D">/trunk/old.txt</path>
    </paths>
  </logentry>
</log>`;

    const logEntries = await parseSvnLog(xml);
    expect(logEntries.length).toBe(1);

    const commit = logEntries[0];
    expect(commit.paths.length).toBe(3);

    // E2E: Verify path content (_) accessible for tree item creation
    // This is the property accessed in repoLogProvider.ts:351,353,356
    const pathElem = commit.paths[0];
    expect(pathElem._).toBe("/trunk/src/file.txt");

    // E2E: Verify path.basename() works (was the crash point)
    const basename = path.basename(pathElem._);
    expect(basename).toBe("file.txt");

    // E2E: Verify path.dirname() works
    const dirname = path.dirname(pathElem._);
    expect(dirname).toBe("/trunk/src");

    // E2E: Verify all paths and actions
    expect(commit.paths[1]._).toBe("/trunk/newdir");
    expect(commit.paths[1].action).toBe("A");
    expect(commit.paths[2]._).toBe("/trunk/old.txt");
    expect(commit.paths[2].action).toBe("D");
  });

  it("handles revision with no paths", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<log>
  <logentry revision="125">
    <author>user</author>
    <date>2025-11-15T10:00:00.000000Z</date>
    <msg>Empty commit</msg>
  </logentry>
</log>`;

    const logEntries = await parseSvnLog(xml);
    expect(logEntries.length).toBe(1);
    expect(Array.isArray(logEntries[0].paths)).toBe(true);
    expect(logEntries[0].paths.length).toBe(0);
  });

  it("parses paths with special characters", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<log>
  <logentry revision="127">
    <author>user</author>
    <date>2025-11-15T10:00:00.000000Z</date>
    <msg>Special chars</msg>
    <paths>
      <path kind="file" action="M">/trunk/my file (copy).txt</path>
    </paths>
  </logentry>
</log>`;

    const logEntries = await parseSvnLog(xml);
    const pathElem = logEntries[0].paths[0];

    // E2E: Special characters in path content
    expect(pathElem._).toBe("/trunk/my file (copy).txt");
    const basename = path.basename(pathElem._);
    expect(basename).toBe("my file (copy).txt");
  });

  it("handles property-only commits with root path", async () => {
    // SVN property-only commits include "/" for root directory changes
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<log>
  <logentry revision="56">
    <author>testuser</author>
    <date>2025-12-17T14:18:42.118799Z</date>
    <msg>chore(ignore): add svn:ignore prop</msg>
    <paths>
      <path action="M" prop-mods="true" text-mods="false" kind="dir">/</path>
      <path action="M" prop-mods="true" text-mods="false" kind="dir">/Main Development</path>
    </paths>
  </logentry>
</log>`;

    const logEntries = await parseSvnLog(xml);
    expect(logEntries.length).toBe(1);
    expect(logEntries[0].paths.length).toBe(2);

    // Root path "/" should be parseable
    expect(logEntries[0].paths[0]._).toBe("/");
    expect(logEntries[0].paths[1]._).toBe("/Main Development");
  });
});

describe("commit tree items carry unique ids (reveal correctness)", () => {
  it("two commits with IDENTICAL messages get distinct TreeItem ids", async () => {
    const { RepoLogProvider } = await import(
      "../../../src/historyView/repoLogProvider"
    );
    const { LogTreeItemKind } = await import("../../../src/historyView/common");
    const mk = (revision: string) => ({
      kind: LogTreeItemKind.Commit,
      data: {
        revision,
        author: "a",
        msg: "update", // duplicate first line = duplicate label
        date: "2026-01-01T00:00:00.000000Z",
        paths: []
      }
    });
    const getTreeItem = (
      RepoLogProvider.prototype as unknown as Record<string, unknown>
    ).getTreeItem as (this: unknown, e: unknown) => { id?: string };

    const a = getTreeItem.call({}, mk("100"));
    const b = getTreeItem.call({}, mk("200"));

    // Without ids, VS Code derives reveal handles from the LABEL - equal
    // messages made "Show in History" land on the wrong commit
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });
});
