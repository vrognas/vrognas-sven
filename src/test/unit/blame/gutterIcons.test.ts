import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { BlameProvider } from "../../../blame/blameProvider";
import { Repository } from "../../../repository";

suite("Gutter Icon Tests", () => {
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

  suite("SVG Generation", () => {
    test("produces valid data URI", () => {
      const color = "#ff0000";
      const uri = (provider as any).generateColorBarSvg(color);
      const uriStr = uri.toString();

      assert.ok(uriStr.startsWith("data:image/svg+xml;base64,"));
      assert.ok(uriStr.length > 50);
    });

    test("contains correct viewBox dimensions", () => {
      const color = "#00ff00";
      const uri = (provider as any).generateColorBarSvg(color);
      const decoded = Buffer.from(
        uri.toString().split(",")[1],
        "base64"
      ).toString();

      assert.ok(decoded.includes('viewBox="0 0 3 16"'));
      assert.ok(decoded.includes('width="3"'));
      assert.ok(decoded.includes('height="16"'));
    });

    test("embeds color correctly in SVG rect", () => {
      const color = "#123456";
      const uri = (provider as any).generateColorBarSvg(color);
      const decoded = Buffer.from(
        uri.toString().split(",")[1],
        "base64"
      ).toString();

      assert.ok(decoded.includes(`fill="${color}"`));
      assert.ok(decoded.includes("<rect"));
    });
  });

  suite("Color Format Support", () => {
    test("accepts hex color format", () => {
      const hexColors = ["#ff0000", "#00ff00", "#0000ff", "#abc123"];

      hexColors.forEach(color => {
        const uri = (provider as any).generateColorBarSvg(color);
        const decoded = Buffer.from(
          uri.toString().split(",")[1],
          "base64"
        ).toString();

        assert.ok(decoded.includes(color));
      });
    });

    test("accepts HSL color format", () => {
      const hslColors = [
        "hsl(180, 70%, 55%)",
        "hsl(0, 100%, 50%)",
        "hsl(240, 60%, 50%)"
      ];

      hslColors.forEach(color => {
        const uri = (provider as any).generateColorBarSvg(color);
        const decoded = Buffer.from(
          uri.toString().split(",")[1],
          "base64"
        ).toString();

        assert.ok(decoded.includes(color));
      });
    });

    test("handles various hex formats", () => {
      const testCases = [
        "#000000", // Black
        "#ffffff", // White
        "#ff00ff", // Magenta
        "#a1b2c3" // Mixed
      ];

      testCases.forEach(color => {
        assert.doesNotThrow(() => {
          (provider as any).generateColorBarSvg(color);
        });
      });
    });
  });

  suite("SVG Cache", () => {
    test("caches SVG by color", () => {
      const color = "#ff0000";
      const uri1 = (provider as any).generateColorBarSvg(color);
      const uri2 = (provider as any).generateColorBarSvg(color);

      assert.strictEqual(uri1.toString(), uri2.toString());
      assert.strictEqual((provider as any).svgCache.size, 1);
    });

    test("creates separate cache entries for different colors", () => {
      const colors = ["#ff0000", "#00ff00", "#0000ff"];
      const uris = colors.map(c => (provider as any).generateColorBarSvg(c));

      assert.strictEqual((provider as any).svgCache.size, 3);
      assert.notStrictEqual(uris[0].toString(), uris[1].toString());
      assert.notStrictEqual(uris[1].toString(), uris[2].toString());
    });

    test("clears cache on dispose", () => {
      (provider as any).generateColorBarSvg("#ff0000");
      (provider as any).generateColorBarSvg("#00ff00");

      assert.strictEqual((provider as any).svgCache.size, 2);

      provider.dispose();

      assert.strictEqual((provider as any).svgCache.size, 0);
    });
  });

  suite("Color Generation for Revisions", () => {
    const revisionRange = { min: 1, max: 5, uniqueRevisions: [5, 4, 3, 2, 1] };

    test("generates distinct colors for different recent revisions", () => {
      const revisions = ["5", "4", "3"];
      const colors = revisions.map(r =>
        (provider as any).getRevisionColor(r, revisionRange)
      );

      const uniqueColors = new Set(colors);
      assert.strictEqual(uniqueColors.size, 3);
    });

    test("generates hex colors", () => {
      const color = (provider as any).getRevisionColor("4", revisionRange);
      assert.ok(/^#[0-9a-f]{6}$/i.test(color));
    });

    test("produces consistent color for same revision", () => {
      const color1 = (provider as any).getRevisionColor("4", revisionRange);
      const color2 = (provider as any).getRevisionColor("4", revisionRange);

      assert.strictEqual(color1, color2);
    });
  });

  suite("Integration", () => {
    const revisionRange = {
      min: 1,
      max: 6,
      uniqueRevisions: [6, 5, 4, 3, 2, 1]
    };
    test("generates unique SVG for each revision color", () => {
      const revisions = ["6", "5", "4"];

      const svgUris = revisions.map(revision => {
        const color = (provider as any).getRevisionColor(
          revision,
          revisionRange
        );
        return (provider as any).generateColorBarSvg(color);
      });

      const uniqueUris = new Set(svgUris.map(u => u.toString()));
      assert.strictEqual(uniqueUris.size, 3);
    });

    test("caches both revision colors and SVGs", () => {
      const revisions = ["6", "5", "6"];

      revisions.forEach(revision => {
        const color = (provider as any).getRevisionColor(
          revision,
          revisionRange
        );
        (provider as any).generateColorBarSvg(color);
      });

      assert.strictEqual((provider as any).revisionColors.size, 2);
      assert.strictEqual((provider as any).svgCache.size, 2);
    });

    test("generates valid SVG from revision color", () => {
      const color = (provider as any).getRevisionColor("6", revisionRange);
      const uri = (provider as any).generateColorBarSvg(color);
      const decoded = Buffer.from(
        uri.toString().split(",")[1],
        "base64"
      ).toString();

      assert.ok(decoded.includes("<svg"));
      assert.ok(decoded.includes("</svg>"));
      assert.ok(decoded.includes(color));
    });
  });
});
