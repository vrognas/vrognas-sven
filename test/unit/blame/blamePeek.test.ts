import { describe, it, expect, vi, beforeEach } from "vitest";
import { commands, Location, Uri, window } from "vscode";
import { findHunkAnchor, peekBlameChange } from "../../../src/blame/blamePeek";
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

describe("peekBlameChange", () => {
  beforeEach(() => {
    vi.mocked(commands.executeCommand).mockClear();
    vi.mocked(window.setStatusBarMessage).mockClear();
  });

  it("opens a peek at the matching hunk of the revision's diff", async () => {
    const source = { patchRevision: vi.fn(async () => PATCH) };
    const uri = Uri.file("/ws/model.R");

    await peekBlameChange(source, uri, "401", 12, "new computation");

    const call = vi
      .mocked(commands.executeCommand)
      .mock.calls.find(c => c[0] === "editor.action.peekLocations");
    expect(call).toBeDefined();
    const [, anchorUri, position, locations] = call!;
    expect(String(anchorUri)).toContain("model.R");
    expect((position as { line: number }).line).toBe(12);
    const loc = (locations as Location[])[0]!;
    expect(loc.uri.toString()).toContain(".diff");
  });
});

describe("blame hover peek link", () => {
  it("links Peek Change with uri, revision and line args", () => {
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

    expect(md.value).toContain(
      `command:sven.blame.peekChange?${encodeURIComponent(
        JSON.stringify(["file:///ws/model.R", "401", 12])
      )}`
    );
  });
});
