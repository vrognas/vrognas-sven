import { describe, it, expect } from "vitest";
import { buildBlameHover } from "../../../src/blame/blameHover";
import { ISvnBlameLine } from "../../../src/common/types";

const line: ISvnBlameLine = {
  lineNumber: 5,
  revision: "4711",
  author: "alice",
  date: "2026-03-01T10:00:00.000000Z"
};

describe("buildBlameHover", () => {
  it("links to the commit in Repo History and to copy-revision", () => {
    const md = buildBlameHover(line, "fix: parser crash");

    expect(md.value).toContain("**r4711**");
    expect(md.value).toContain("alice");
    expect(md.value).toContain("fix: parser crash");
    // goToRevision takes the revision as a NUMBER argument
    expect(md.value).toContain(
      `command:sven.repolog.goToRevision?${encodeURIComponent(JSON.stringify([4711]))}`
    );
    expect(md.value).toContain("command:sven.blame.copyRevision?");
  });

  it("restricts executable commands to exactly the link targets", () => {
    const md = buildBlameHover(line);

    expect(md.isTrusted).toEqual({
      enabledCommands: [
        "sven.repolog.goToRevision",
        "sven.blame.copyRevision",
        "sven.blame.showDiff"
      ]
    });
    // no message provided: metadata line still renders, no undefined leak
    expect(md.value).not.toContain("undefined");
    // no file uri provided: the diff link is omitted entirely
    expect(md.value).not.toContain("sven.blame.showDiff");
  });

  it("adds the Diff with Previous link when the file uri is known", () => {
    const md = buildBlameHover(line, undefined, {
      toString: () => "file:///ws/a.R"
    } as never);

    expect(md.value).toContain("command:sven.blame.showDiff?");
    expect(md.value).toContain(
      encodeURIComponent(JSON.stringify(["file:///ws/a.R", "4711"]))
    );
  });

  it("separates metadata with dots like the history descriptions", () => {
    const md = buildBlameHover(line);

    expect(md.value).toContain("·");
    expect(md.value).not.toContain("—");
  });

  it("marks the file's ADD revision and drops the diff link (no previous rev exists)", () => {
    const md = buildBlameHover(
      line,
      undefined,
      { toString: () => "file:///ws/a.R" } as never,
      "4711" // the blamed revision IS the file's add revision
    );

    expect(md.value).toContain("added this file");
    expect(md.value).not.toContain("sven.blame.showDiff");
  });

  it("keeps the diff link when the line is newer than the add revision", () => {
    const md = buildBlameHover(
      line,
      undefined,
      { toString: () => "file:///ws/a.R" } as never,
      "12" // file added long before this line's r4711
    );

    expect(md.value).not.toContain("added this file");
    expect(md.value).toContain("command:sven.blame.showDiff?");
  });
});
