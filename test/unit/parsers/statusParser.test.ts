import { describe, it, expect } from "vitest";
import { parseStatusXml } from "../../../src/parser/statusParser";

describe("StatusParser - Rename Detection", () => {
  it("parses every target from a multi-path status", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<status>
  <target path="vendor-a">
    <entry path="vendor-a/nested">
      <wc-status item="external" props="none"/>
    </entry>
  </target>
  <target path="vendor-b">
    <entry path="vendor-b/file.txt">
      <wc-status item="modified" props="none"/>
    </entry>
  </target>
</status>`;

    const result = await parseStatusXml(xml);

    expect(result.map(status => [status.path, status.status])).toEqual([
      ["vendor-a/nested", "external"],
      ["vendor-b/file.txt", "modified"]
    ]);
  });

  it("detects rename when status is added with moved-from", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<status>
  <target path=".">
    <entry path="new_name.txt">
      <wc-status item="added" props="none" copied="true"
        moved-from="old_name.txt">
        <commit revision="100"/>
      </wc-status>
    </entry>
  </target>
</status>`;

    const result = await parseStatusXml(xml);

    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe("new_name.txt");
    expect(result[0]!.status).toBe("added");
    expect(result[0]!.rename).toBe("old_name.txt");
  });

  it("detects rename when status is replaced with moved-from (chain rename)", async () => {
    // Chain rename: A→B→C makes B have status "replaced" with both moved-from and moved-to
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<status>
  <target path=".">
    <entry path="middle.txt">
      <wc-status item="replaced" props="none" copied="true"
        moved-from="original.txt"
        moved-to="final.txt">
        <commit revision="100"/>
      </wc-status>
    </entry>
  </target>
</status>`;

    const result = await parseStatusXml(xml);

    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe("middle.txt");
    expect(result[0]!.status).toBe("replaced");
    expect(result[0]!.rename).toBe("original.txt");
  });

  it("skips deleted entry with moved-to (source of rename)", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<status>
  <target path=".">
    <entry path="old_name.txt">
      <wc-status item="deleted" props="none"
        moved-to="new_name.txt">
        <commit revision="100"/>
      </wc-status>
    </entry>
  </target>
</status>`;

    const result = await parseStatusXml(xml);

    // Deleted entries with moved-to are skipped (only show destination)
    expect(result.length).toBe(0);
  });
});
