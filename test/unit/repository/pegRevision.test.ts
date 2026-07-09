import { describe, it, expect } from "vitest";
import { fixPegRevision } from "../../../src/util";

/**
 * SVN peg revision target construction.
 *
 * svn resolves the peg at the LAST '@' of a target:
 * - `name@2x.png@123`  → path `name@2x.png`, peg 123 (correct)
 * - `name@2x.png@@123` → path `name@2x.png@` (literal, doesn't exist)
 * - `name@2x.png@`     → path `name@2x.png`, no peg (the escape form)
 *
 * So an explicit peg is appended UNESCAPED; the trailing-@ escape applies
 * only to peg-less targets containing '@'. An earlier revision of this
 * suite pinned escape-then-append (`@@123`), which broke every pegged
 * log/cat/diff for @-named files.
 */
describe("fixPegRevision peg construction", () => {
  it("appends explicit peg to plain paths", () => {
    expect(fixPegRevision("svn://srv/repo/trunk/report.pdf", "1454")).toBe(
      "svn://srv/repo/trunk/report.pdf@1454"
    );
  });

  it("appends explicit peg to @-named paths without escaping", () => {
    expect(fixPegRevision("svn://srv/repo/trunk/data@2024.csv", "1454")).toBe(
      "svn://srv/repo/trunk/data@2024.csv@1454"
    );
  });

  it("escapes @-named paths with a trailing @ when no peg is given", () => {
    expect(fixPegRevision("svn://srv/repo/trunk/data@2024.csv")).toBe(
      "svn://srv/repo/trunk/data@2024.csv@"
    );
  });

  it("leaves plain paths untouched when no peg is given", () => {
    expect(fixPegRevision("svn://srv/repo/trunk/report.pdf")).toBe(
      "svn://srv/repo/trunk/report.pdf"
    );
  });

  it("treats empty-string peg as no peg", () => {
    expect(fixPegRevision("svn://srv/repo/trunk/report.pdf", "")).toBe(
      "svn://srv/repo/trunk/report.pdf"
    );
    expect(fixPegRevision("svn://srv/repo/trunk/data@2024.csv", "")).toBe(
      "svn://srv/repo/trunk/data@2024.csv@"
    );
  });

  it("handles multiple @ in filename with a peg", () => {
    expect(
      fixPegRevision("svn://srv/repo/trunk/file@v1@final.txt", "100")
    ).toBe("svn://srv/repo/trunk/file@v1@final.txt@100");
  });
});
