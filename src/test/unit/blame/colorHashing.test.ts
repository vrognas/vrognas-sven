import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { BlameProvider } from "../../../blame/blameProvider";
import { Repository } from "../../../repository";

suite("BlameProvider - Revision Coloring", () => {
  let provider: BlameProvider;
  let mockRepository: sinon.SinonStubbedInstance<Repository>;
  let sandbox: sinon.SinonSandbox;
  const revisionRange = { min: 1, max: 6, uniqueRevisions: [6, 5, 4, 3, 2, 1] };

  setup(() => {
    sandbox = sinon.createSandbox();
    mockRepository = sandbox.createStubInstance(Repository);
    provider = new BlameProvider(scmFor(mockRepository as any));
  });

  teardown(() => {
    provider.dispose();
    sandbox.restore();
  });

  test("generates consistent color for same revision", () => {
    const revision = "1234";

    const color1 = (provider as any).getRevisionColor(revision, revisionRange);
    const color2 = (provider as any).getRevisionColor(revision, revisionRange);

    assert.strictEqual(color1, color2);
    assert.strictEqual((provider as any).revisionColors.size, 1);
  });

  test("generates different colors for different recent revisions", () => {
    const revisions = ["6", "5", "4", "3", "2"];
    const colors = revisions.map(r =>
      (provider as any).getRevisionColor(r, revisionRange)
    );
    const uniqueColors = new Set(colors);

    assert.strictEqual(uniqueColors.size, revisions.length);
  });

  test("generates hex colors", () => {
    const revisions = ["10", "11", "12"];
    const colors = revisions.map(r =>
      (provider as any).getRevisionColor(r, revisionRange)
    );
    colors.forEach(color => {
      assert.ok(
        /^#[0-9a-f]{6}$/i.test(color),
        `Expected hex color, got: ${color}`
      );
    });
  });

  test("uses cache to avoid redundant color conversion", () => {
    const hslToHexSpy = sandbox.spy(provider as any, "hslToHex");
    const revision = "7777";
    for (let i = 0; i < 5; i++) {
      (provider as any).getRevisionColor(revision, revisionRange);
    }

    assert.strictEqual(hslToHexSpy.callCount, 1);
    assert.strictEqual((provider as any).revisionColors.size, 1);
  });

  test("handles invalid revision with fallback color", () => {
    const color = (provider as any).getRevisionColor(
      "not-a-number",
      revisionRange
    );
    assert.ok(/^#[0-9a-f]{6}$/i.test(color));
  });
});
