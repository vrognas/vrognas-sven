import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { BlameProvider } from "../../../blame/blameProvider";
import { Repository } from "../../../repository";

suite("BlameProvider - SVG Generation", () => {
  let provider: BlameProvider;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    const mockRepo = sandbox.createStubInstance(Repository);
    provider = new BlameProvider(scmFor(mockRepo as any));
  });

  teardown(() => {
    provider.dispose();
    sandbox.restore();
  });

  test("generates valid SVG data URI", () => {
    // Given: Color
    const color = "#ff0000";

    // When: Generate SVG
    const uri = (provider as any).generateColorBarSvg(color);

    // Then: Valid data URI format
    const uriStr = uri.toString();
    assert.ok(uriStr.startsWith("data:image/svg+xml;base64,"));

    // Decode and verify SVG content
    const base64 = uriStr.split(",")[1];
    const decoded = Buffer.from(base64, "base64").toString();

    assert.ok(decoded.includes("<svg"));
    assert.ok(decoded.includes("</svg>"));
    assert.ok(decoded.includes("xmlns"));
  });

  test("embeds color correctly in SVG", () => {
    // Given: Specific test colors
    const testColors = ["#123456", "#abcdef", "hsl(180, 70%, 55%)"];

    // When: Generate SVGs
    testColors.forEach(color => {
      const uri = (provider as any).generateColorBarSvg(color);
      const decoded = Buffer.from(
        uri.toString().split(",")[1],
        "base64"
      ).toString();

      // Then: Color appears in SVG
      assert.ok(decoded.includes(color), `Color ${color} not found in SVG`);
      assert.ok(decoded.includes('fill="'), "Missing fill attribute");
    });
  });

  test("caches SVGs by color to avoid regeneration", () => {
    // Given: Same color requested multiple times
    const color = "#ff0000";

    // When: Generate 5 times
    const uris = Array.from({ length: 5 }, () =>
      (provider as any).generateColorBarSvg(color)
    );

    // Then: All return same cached URI (reference equality)
    const firstUri = uris[0].toString();
    uris.forEach(uri => {
      assert.strictEqual(uri.toString(), firstUri);
    });

    // Verify cache size
    assert.strictEqual((provider as any).svgCache.size, 1);
  });

  test("generates SVG with correct dimensions", () => {
    // Given: Color
    const color = "#00ff00";

    // When: Generate SVG
    const uri = (provider as any).generateColorBarSvg(color);
    const decoded = Buffer.from(
      uri.toString().split(",")[1],
      "base64"
    ).toString();

    // Then: Verify dimensions (3px wide, 16px height)
    assert.ok(decoded.includes('width="3"'), "Width should be 3px");
    assert.ok(
      decoded.includes('viewBox="0 0 3 16"'),
      "ViewBox should be 0 0 3 16"
    );
  });
});
