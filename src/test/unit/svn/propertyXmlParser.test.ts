import * as assert from "assert";
import { afterEach, vi } from "vitest";
import {
  parseSvnPropertiesXml,
  propertyValues
} from "../../../parser/propertyParser";
import { XmlParserAdapter } from "../../../parser/xmlParserAdapter";

suite("SVN property XML parser", () => {
  afterEach(() => vi.restoreAllMocks());

  test("preserves property text, presence, and encoded paths", () => {
    const entries = parseSvnPropertiesXml(`<?xml version="1.0"?>
<properties>
  <target path="dir &amp; name">
    <property name="svn:eol-style">true</property>
    <property name="custom">  first
second &amp; &#x41;  </property>
    <property name="svn:needs-lock"/>
    <property name="svn:ignore" encoding="base64">dG1wCmNhY2hl</property>
  </target>
</properties>`);

    assert.strictEqual(
      propertyValues(entries, "svn:eol-style").get("dir & name"),
      "true"
    );
    assert.strictEqual(
      propertyValues(entries, "custom").get("dir & name"),
      "  first\nsecond & A  "
    );
    assert.strictEqual(
      propertyValues(entries, "svn:needs-lock").get("dir & name"),
      ""
    );
    assert.strictEqual(
      propertyValues(entries, "svn:ignore").get("dir & name"),
      "tmp\ncache"
    );
  });

  test("accepts rooted and root-stripped adapter shapes", () => {
    vi.spyOn(XmlParserAdapter, "parse")
      .mockReturnValueOnce({
        properties: {
          target: { path: "rooted", property: { name: "flag", _: true } }
        }
      })
      .mockReturnValueOnce({
        target: [
          { path: "plain", property: { name: "flag", _: false } },
          { path: "empty", property: { name: "flag" } }
        ]
      });

    assert.strictEqual(
      propertyValues(parseSvnPropertiesXml("rooted"), "flag").get("rooted"),
      "true"
    );
    const stripped = parseSvnPropertiesXml("stripped");
    assert.strictEqual(propertyValues(stripped, "flag").get("plain"), "false");
    assert.strictEqual(propertyValues(stripped, "flag").get("empty"), "");
  });

  test("rejects missing target or property identity", () => {
    vi.spyOn(XmlParserAdapter, "parse")
      .mockReturnValueOnce({ target: { property: { name: "flag" } } })
      .mockReturnValueOnce({ target: { path: ".", property: {} } });

    assert.throws(() => parseSvnPropertiesXml("missing path"));
    assert.throws(() => parseSvnPropertiesXml("missing name"));
    vi.restoreAllMocks();
    assert.throws(() => parseSvnPropertiesXml("<not-properties/>"));
  });
});
