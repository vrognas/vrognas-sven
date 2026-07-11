import { describe, it, expect, vi } from "vitest";
import { commands, Location, Uri } from "vscode";
import {
  blamePeekLinkProvider,
  findHunkAnchor,
  peekLatestChange,
  peekLineHistory,
  walkLineHistory
} from "../../../src/blame/blamePeek";
import { buildBlameHover } from "../../../src/blame/blameHover";
import { ISvnBlameLine } from "../../../src/common/types";

/**
 * "Peek Change" on a blame hover: an inline peek of the diff hunk the
 * blamed revision made around that line - without leaving the editor.
 */

const PATCH = `Index: model.R
===================================================================
--- model.R\t(revision 400)
+++ model.R\t(revision 401)
@@ -10,4 +10,5 @@
 context above
-old computation
+new computation
+  extra_step()
 context below
@@ -40,3 +41,4 @@
 tail context
+appended_line()
 more tail
`;

describe("findHunkAnchor", () => {
  it("anchors at the added line matching the blamed text", () => {
    const lines = PATCH.split(/\r?\n/);

    const anchor = findHunkAnchor(PATCH, "  appended_line()  ");

    expect(lines[anchor]).toBe("+appended_line()");
  });

  it("falls back to the first hunk header when nothing matches", () => {
    const lines = PATCH.split(/\r?\n/);

    const anchor = findHunkAnchor(PATCH, "not in the diff");

    expect(lines[anchor]).toBe("@@ -10,4 +10,5 @@");
  });
});

describe("walkLineHistory (blame chaining)", () => {
  /**
   * Repo fixture: line 2 was added as "B0" in r10, edited to "B2" in
   * r20. Contents by revision; blame pegged at a revision annotates
   * that revision's content.
   */
  function makeSource() {
    const contents: Record<string, string> = {
      BASE: "a\nB2\nc",
      "19": "a\nB0\nc"
    };
    const blames: Record<string, string[]> = {
      // per-line revisions for lines 1..3
      BASE: ["5", "20", "5"],
      "19": ["5", "10", "5"]
    };
    return {
      show: vi.fn(async (_f: unknown, rev?: string) => {
        const c = contents[rev ?? "BASE"];
        if (c === undefined) {
          throw new Error("svn: E195002: no such revision for this file");
        }
        return c;
      }),
      blame: vi.fn(
        async (_f: string, rev?: string, _skipCache?: boolean, _peg?: string) =>
          (blames[rev ?? "BASE"] ?? []).map((revision, i) => ({
            lineNumber: i + 1,
            revision,
            author: "a",
            date: "2026-01-01"
          }))
      ),
      getInfo: vi.fn(async () => ({ revision: "3000" })),
      patchRevision: vi.fn(
        async (rev: string) =>
          `@@ -2,1 +2,1 @@\n-old\n+${rev === "20" ? "B2" : "B0"}\n`
      )
    };
  }

  it("collects every revision that changed the line, newest first", async () => {
    const source = makeSource();

    const changes = await walkLineHistory(source, "/ws/model.R", 2);

    expect(changes.map(c => c.revision)).toEqual(["20", "10"]);
    // the tracked line's text AT each revision anchors the peek later
    expect(changes.map(c => c.lineText)).toEqual(["B2", "B0"]);
    // hops peg the target at the BASE revision (where the current name
    // is valid) so svn traces the lineage back THROUGH renames
    expect(source.blame).toHaveBeenCalledWith(
      "/ws/model.R",
      "19",
      false,
      "3000"
    );
    expect(source.show).toHaveBeenCalledWith("/ws/model.R", "19", "3000");
  });

  it("stops when the line has no ancestor in the older content", async () => {
    const source = makeSource();
    // older revision doesn't contain anything like line 2
    source.show.mockImplementation(async (_f: unknown, rev?: string) => {
      if ((rev ?? "BASE") === "BASE") return "a\nB2\nc";
      return "a\nc";
    });

    const changes = await walkLineHistory(source, "/ws/model.R", 2);

    expect(changes.map(c => c.revision)).toEqual(["20"]);
  });
});

describe("peekLineHistory", () => {
  it("opens a multi-location peek: one entry per change, scrollable", async () => {
    vi.mocked(commands.executeCommand).mockClear();
    const contents: Record<string, string> = {
      BASE: "a\nB2\nc",
      "19": "a\nB0\nc"
    };
    const blames: Record<string, string[]> = {
      BASE: ["5", "20", "5"],
      "19": ["5", "10", "5"]
    };
    const source = {
      show: async (_f: unknown, rev?: string) => {
        const c = contents[rev ?? "BASE"];
        if (c === undefined) throw new Error("E195002");
        return c;
      },
      blame: async (_f: string, rev?: string) =>
        (blames[rev ?? "BASE"] ?? []).map((revision, i) => ({
          lineNumber: i + 1,
          revision
        })),
      getInfo: async () => ({ revision: "3000" }),
      patchRevision: async (rev: string) =>
        `@@ -2,1 +2,1 @@\n+${rev === "20" ? "B2" : "B0"}\n`
    };
    const uri = Uri.file("/ws/model.R");

    await peekLineHistory(source as never, uri, 2, 1);

    const call = vi
      .mocked(commands.executeCommand)
      .mock.calls.find(c => c[0] === "editor.action.peekLocations");
    expect(call).toBeDefined();
    const locations = call![3] as Location[];
    expect(locations).toHaveLength(2);
    expect(locations.every(l => l.uri.toString().includes(".diff"))).toBe(true);
    // r20's doc and r10's doc are distinct temp files
    expect(locations[0]!.uri.toString()).not.toBe(locations[1]!.uri.toString());
  });
});

describe("blame hover peek link", () => {
  it("Peek Changes opens the instant latest-change peek", () => {
    const line: ISvnBlameLine = {
      lineNumber: 5,
      revision: "401",
      author: "alice",
      date: "2026-03-01T10:00:00.000000Z"
    };

    const md = buildBlameHover(
      line,
      undefined,
      { toString: () => "file:///ws/model.R" } as never,
      undefined,
      12 // working-copy line the decoration sits on
    );

    // args: uri, revision, BASE line, working line
    expect(md.value).toContain("Peek Changes");
    expect(md.value).toContain(
      `command:sven.blame.peekChanges?${encodeURIComponent(
        JSON.stringify(["file:///ws/model.R", "401", 5, 12])
      )}`
    );
  });
});

describe("peekLatestChange (the fast default peek)", () => {
  function makeSource() {
    return {
      patchRevision: vi.fn(async () => PATCH),
      show: vi.fn(async () => "l1\nnew computation\nl3"),
      blame: vi.fn(async () => []),
      getInfo: vi.fn(async () => ({ revision: "3000" }))
    };
  }

  it("opens instantly with the latest hunk and a load-all header link", async () => {
    vi.mocked(commands.executeCommand).mockClear();
    const uri = Uri.file("/ws/model.R");

    await peekLatestChange(makeSource() as never, uri, "401", 2, 12);

    const call = vi
      .mocked(commands.executeCommand)
      .mock.calls.find(c => c[0] === "editor.action.peekLocations");
    expect(call).toBeDefined();
    const locations = call![3] as Location[];
    expect(locations).toHaveLength(1);
    const diffDocUri = locations[0]!.uri;

    // the diff document carries the in-peek "load ALL revisions" link
    const doc = {
      uri: diffDocUri,
      getText: () =>
        "### Latest change only - click here to load ALL revisions of this line ###\nrest"
    };
    const links = blamePeekLinkProvider.provideDocumentLinks(doc as never);
    expect(links).toHaveLength(1);
    expect(String(links[0]!.target)).toContain("sven.blame.peekLineHistory");
    expect(String(links[0]!.target)).toContain(
      encodeURIComponent(JSON.stringify([uri.toString(), 2, 12]))
    );
  });

  it("provides no link for unrelated tempsvnfs documents", () => {
    const doc = {
      uri: Uri.parse("tempsvnfs:/hash/r5_other.R.diff"),
      getText: () => "@@ -1 +1 @@\n+x\n"
    };

    expect(
      blamePeekLinkProvider.provideDocumentLinks(doc as never)
    ).toHaveLength(0);
  });
});
