import * as assert from "assert";
import { getBranchName } from "../../../helpers/branchName";

suite("branchName", () => {
  test("extracts trunk name", () => {
    assert.deepStrictEqual(getBranchName("project/trunk"), {
      name: "trunk",
      path: "trunk"
    });
  });

  test("extracts branch name", () => {
    assert.deepStrictEqual(getBranchName("project/branches/team-a"), {
      name: "team-a",
      path: "branches/team-a"
    });
  });

  test("rejects unrelated folders", () => {
    assert.strictEqual(getBranchName("project/archive/team-a"), undefined);
  });
});
