import { scmFor } from "./helpers/blameScm";
import * as assert from "assert";
import * as sinon from "sinon";
import { BlameProvider } from "../../../blame/blameProvider";
import { blameConfiguration } from "../../../blame/blameConfiguration";
import { Repository } from "../../../repository";
import { ISvnBlameLine } from "../../../common/types";

suite("BlameProvider - Text Formatting", () => {
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

  test("truncates message at word boundary", () => {
    // Given: Long message exceeding max length
    const message =
      "This is a very long commit message that should be truncated";
    sandbox.stub(blameConfiguration, "getInlineMaxLength").returns(30);

    // When: Truncate message
    const result = (provider as any).truncateMessage(message);

    // Then: Truncated with ellipsis
    assert.ok(result.length <= 30);
    assert.ok(result.includes("..."));

    // Verify word boundary (no partial words before ellipsis)
    const beforeEllipsis = result.replace("...", "");
    assert.ok(!beforeEllipsis.endsWith(" "), "Should not end with space");
  });

  test("uses only first line of multi-line message", () => {
    // Given: Multi-line commit message
    const message = "First line summary\n\nDetailed explanation\nMore details";

    // When: Truncate
    const result = (provider as any).truncateMessage(message);

    // Then: Only first line included
    assert.ok(result.includes("First line summary"));
    assert.ok(!result.includes("Detailed explanation"));
    assert.ok(!result.includes("More details"));
    assert.ok(!result.includes("\n"));
  });

  test("substitutes template variables correctly", () => {
    // Given: Template with all variables
    const line: ISvnBlameLine = {
      lineNumber: 1,
      revision: "5678",
      author: "jane.smith",
      date: "2025-11-18"
    };
    const message = "Test message";
    sandbox
      .stub(blameConfiguration, "getInlineTemplate")
      .returns("${author} (r${revision}): ${message}");

    // When: Format
    const result = (provider as any).formatInlineText(line, message);

    // Then: All variables substituted
    assert.ok(result.includes("jane.smith"));
    assert.ok(result.includes("r5678"));
    assert.ok(result.includes("Test message"));
    assert.strictEqual(result, "jane.smith (r5678): Test message");
  });

  test("handles empty message gracefully", () => {
    // Given: Empty message
    const line: ISvnBlameLine = {
      lineNumber: 1,
      revision: "1234",
      author: "john",
      date: "2025-11-18"
    };
    const message = "";

    sandbox
      .stub(blameConfiguration, "getInlineTemplate")
      .returns("${author} (r${revision}): ${message}");

    // When: Format
    const result = (provider as any).formatInlineText(line, message);

    // Then: Template renders with empty message
    assert.ok(result.includes("john"));
    assert.ok(result.includes("1234"));
    // Message part is empty but template structure intact
    assert.strictEqual(result, "john (r1234): ");
  });
});
