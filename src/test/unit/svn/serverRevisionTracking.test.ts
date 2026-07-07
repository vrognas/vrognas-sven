import * as assert from "assert";
import { makeFakeSvnRepo } from "./helpers/fakeSvnRepository";

const logXml = (rev: number) => `<?xml version="1.0"?>
<log>
<logentry revision="${rev}">
<author>alice</author>
<date>2026-01-01T00:00:00.000000Z</date>
<msg>m</msg>
</logentry>
</log>`;

suite("Server revision tracking", () => {
  test("probe uses descending HEAD:BASE and returns the youngest revision", async () => {
    const { repo, setExec } = await makeFakeSvnRepo();
    (repo as any)._info = { revision: "100" };

    let capturedArgs: string[] = [];
    setExec(async () => ({ stdout: logXml(108) }));
    repo.exec = async (args: string[]) => {
      capturedArgs = args;
      return { stdout: logXml(108) };
    };

    const probe = await repo.hasRemoteChanges();

    assert.ok(
      capturedArgs.join(" ").includes("HEAD:BASE"),
      `probe must use a DESCENDING range so --limit 1 returns the YOUNGEST ` +
        `revision, not the oldest (got: ${capturedArgs.join(" ")})`
    );
    assert.strictEqual(probe.hasChanges, true);
    assert.strictEqual(probe.youngestRevision, 108);
  });

  test("probe reports no changes when youngest == BASE (inclusive range)", async () => {
    const { repo } = await makeFakeSvnRepo();
    (repo as any)._info = { revision: "100" };
    repo.exec = async (_args: string[]) => ({ stdout: logXml(100) });

    const probe = await repo.hasRemoteChanges();

    assert.strictEqual(
      probe.hasChanges,
      false,
      "HEAD:BASE includes BASE itself - a single entry at BASE is not an incoming change"
    );
    assert.strictEqual(probe.youngestRevision, 100);
  });

  test("Repository records server revisions monotonically", async () => {
    const { Repository } = await import("../../../repository");
    const mockThis: any = {};
    const record = (Repository.prototype as any).recordServerRevision;

    record.call(mockThis, 105);
    assert.strictEqual(mockThis._lastKnownServerRevision.revision, 105);

    record.call(mockThis, 103); // older observation must not regress
    assert.strictEqual(mockThis._lastKnownServerRevision.revision, 105);

    record.call(mockThis, 110);
    assert.strictEqual(mockThis._lastKnownServerRevision.revision, 110);

    record.call(mockThis, undefined); // no-op
    assert.strictEqual(mockThis._lastKnownServerRevision.revision, 110);
  });
});
