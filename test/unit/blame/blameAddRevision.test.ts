import { describe, it, expect, vi } from "vitest";
import { Uri } from "vscode";
import { BlameProvider } from "../../../src/blame/blameProvider";
import { ISvnBlameLine } from "../../../src/common/types";

/**
 * Lines whose revision is the file's ADD revision are marked in the
 * blame hover (and lose the meaningless "Diff with Previous" link).
 * The add revision comes from `svn log -r 1:HEAD --limit=1 <file>` -
 * the FIRST revision that touched the file's lineage.
 */

const uri = Uri.file("/ws/model.R");

function proto(method: string) {
  return (BlameProvider.prototype as unknown as Record<string, unknown>)[
    method
  ] as (this: unknown, ...args: unknown[]) => unknown;
}

describe("blame add-revision marking", () => {
  it("ensureAddRevision resolves and caches the file's first revision", async () => {
    const log = vi.fn(async () => [{ revision: "401" } as never]);
    const repository = { repository: { log } };
    const mockThis = {
      addRevisionCache: new Map<string, string>(),
      repository,
      repoFor: () => repository,
      claimOwner: () => ({ repository }),
      isCurrentOwner: () => true
    };

    await (
      proto("ensureAddRevision") as (this: unknown, uri: Uri) => Promise<void>
    ).call(mockThis, uri);

    // oldest-first probe: -r 1:HEAD --limit=1
    expect(log).toHaveBeenCalledWith("1", "HEAD", 1, uri.fsPath);
    expect(mockThis.addRevisionCache.get(uri.toString())).toBe("401");
  });

  it("negative-caches failures so offline sessions don't respawn svn per render", async () => {
    const log = vi.fn(async () => {
      throw new Error("svn: E170013: Unable to connect");
    });
    const repository = { repository: { log } };
    const mockThis = {
      addRevisionCache: new Map<string, string>(),
      repository,
      repoFor: () => repository,
      claimOwner: () => ({ repository }),
      isCurrentOwner: () => true
    };
    const ensure = proto("ensureAddRevision") as (
      this: unknown,
      uri: Uri
    ) => Promise<boolean>;

    expect(await ensure.call(mockThis, uri)).toBe(false);
    expect(await ensure.call(mockThis, uri)).toBe(false);

    // sentinel cached: exactly ONE doomed spawn, and no marker rendered
    expect(log).toHaveBeenCalledTimes(1);
    expect(mockThis.addRevisionCache.get(uri.toString())).toBe("");
  });

  it("hover for an add-revision line says so and drops the diff link", () => {
    const blameLine: ISvnBlameLine = {
      lineNumber: 1,
      revision: "401",
      author: "alice",
      date: "2026-03-01T10:00:00.000000Z"
    };
    const editor = {
      document: {
        uri,
        lineAt: () => ({ range: { end: { character: 10 } } })
      }
    };
    const mockThis = {
      messageCache: new Map<string, string>(),
      addRevisionCache: new Map([[uri.toString(), "401"]]),
      readMessage(this: { messageCache: Map<string, string> }, r: string) {
        return this.messageCache.get(r);
      }
    };

    const decoration = (
      proto("buildInlineDecoration") as (
        this: unknown,
        editor: unknown,
        lineIndex: number,
        blameLine: ISvnBlameLine,
        inlineText: string,
        inlineColor: string
      ) => { hoverMessage: { value: string } }
    ).call(mockThis, editor, 0, blameLine, "text", "#888");

    expect(decoration.hoverMessage.value).toContain("added this file");
    expect(decoration.hoverMessage.value).not.toContain("sven.blame.showDiff");
  });
});
