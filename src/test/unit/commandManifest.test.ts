import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

/**
 * Manifest-integrity guards for contributes.commands.
 *
 * Catches the "command not found" class of bug: a command declared or
 * referenced in package.json that no code registers (e.g. orphaned
 * entries left behind when a feature is removed).
 *
 * The registration check is a literal-string heuristic: a registered
 * command id must appear as a quoted "sven.x" / 'sven.x' literal somewhere
 * in non-test src. This intentionally requires literal command ids (no
 * runtime string concatenation), which is the convention here anyway.
 */
const root = process.cwd();
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf-8")
);
const declared: string[] = pkg.contributes.commands.map(
  (c: { command: string }) => c.command
);

function collectNonTestSource(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "test") continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(fs.readFileSync(full, "utf-8"));
      }
    }
  };
  walk(path.join(root, "src"));
  return out.join("\n");
}

const srcText = collectNonTestSource();

function referencedCommands(): Set<string> {
  const refs = new Set<string>();
  const menus = pkg.contributes.menus ?? {};
  for (const group of Object.values(menus) as { command?: string }[][]) {
    for (const item of group) {
      if (item.command) refs.add(item.command);
    }
  }
  for (const kb of (pkg.contributes.keybindings ?? []) as {
    command?: string;
  }[]) {
    if (kb.command) refs.add(kb.command);
  }
  return refs;
}

suite("command manifest integrity", () => {
  test("has no duplicate command ids", () => {
    const seen = new Set<string>();
    const dups = declared.filter(id =>
      seen.has(id) ? true : (seen.add(id), false)
    );
    assert.deepStrictEqual(
      dups,
      [],
      `duplicate command ids: ${dups.join(", ")}`
    );
  });

  test("every declared command is registered in code", () => {
    const orphaned = declared.filter(
      id => !srcText.includes(`"${id}"`) && !srcText.includes(`'${id}'`)
    );
    assert.deepStrictEqual(
      orphaned,
      [],
      `declared in package.json but never registered (would throw "command not found"): ${orphaned.join(", ")}`
    );
  });

  test("every menu/keybinding command is declared", () => {
    const declaredSet = new Set(declared);
    const undeclared = [...referencedCommands()].filter(
      id => id.startsWith("sven.") && !declaredSet.has(id)
    );
    assert.deepStrictEqual(
      undeclared,
      [],
      `referenced in menus/keybindings but not declared: ${undeclared.join(", ")}`
    );
  });
});
