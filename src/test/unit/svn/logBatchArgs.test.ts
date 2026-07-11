import * as assert from "assert";
import { makeFakeSvnRepo } from "./helpers/fakeSvnRepository";

/** Two log entries, no <paths> — the shape svn returns WITHOUT -v. */
const LOG_XML = `<?xml version="1.0"?>
<log>
  <logentry revision="100">
    <author>john</author>
    <date>2025-11-18T10:00:00.000000Z</date>
    <msg>first</msg>
  </logentry>
  <logentry revision="200">
    <author>jane</author>
    <date>2025-11-19T10:00:00.000000Z</date>
    <msg>second</msg>
  </logentry>
</log>`;

suite("svnRepository.logBatch args", () => {
  test("range query omits -v (no consumer reads changed paths)", async () => {
    const { repo } = await makeFakeSvnRepo();
    const calls: string[][] = [];
    repo.exec = async (args: string[]) => {
      calls.push(args);
      return { stdout: LOG_XML };
    };

    const entries = await repo.logBatch(["100", "200"]);

    assert.strictEqual(calls.length, 1, "one range exec");
    const args = calls[0]!;
    assert.ok(args.includes("log") && args.includes("100:200"));
    assert.ok(
      !args.includes("-v"),
      "range logBatch must not request verbose changed-paths"
    );
    // Messages still parse from the non-verbose log.
    assert.deepStrictEqual(entries.map((e: { msg: string }) => e.msg).sort(), [
      "first",
      "second"
    ]);
  });

  test("single revision still delegates to log() (keeps its own args)", async () => {
    const { repo } = await makeFakeSvnRepo();
    const calls: string[][] = [];
    repo.exec = async (args: string[]) => {
      calls.push(args);
      return {
        stdout: `<?xml version="1.0"?><log><logentry revision="100"><author>j</author><date>2025-11-18T10:00:00.000000Z</date><msg>only</msg></logentry></log>`
      };
    };

    const entries = await repo.logBatch(["100"]);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].revision, "100");
  });
});
