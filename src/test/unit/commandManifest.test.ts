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

  // ---- when-clause / view integrity (catches svn->sven rename leftovers) ----

  function allWhenClauses(): string[] {
    const whens: string[] = [];
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) {
        o.forEach(walk);
      } else if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          if (k === "when" && typeof v === "string") whens.push(v);
          else walk(v);
        }
      }
    };
    walk(pkg.contributes);
    return whens;
  }

  test("every svn./sven. context key in when-clauses is set in code", () => {
    // Keys like `sven.historyFilterActive` must be set via setContext in src.
    // Lookbehind excludes `config.sven.*` (settings, checked below) and
    // resourceScheme values like `merge-conflicts.conflicts-diff`.
    const keys = new Set<string>();
    for (const w of allWhenClauses()) {
      for (const m of w.matchAll(
        /(?<![\w.-])((?:svn|sven)\.[A-Za-z0-9_.]+)/g
      )) {
        keys.add(m[1]!);
      }
    }
    const unset = [...keys].filter(k => !srcText.includes(`"${k}"`));
    assert.deepStrictEqual(
      unset,
      [],
      `when-clause context keys never set via setContext in src (menu/view will never appear): ${unset.join(", ")}`
    );
  });

  test("every config.* reference in when-clauses is a declared setting", () => {
    const props = new Set(
      Object.keys(pkg.contributes.configuration?.properties ?? {})
    );
    const bad = new Set<string>();
    for (const w of allWhenClauses()) {
      for (const m of w.matchAll(/config\.([A-Za-z0-9_.]+)/g)) {
        if (!props.has(m[1]!)) bad.add(`config.${m[1]!}`);
      }
    }
    assert.deepStrictEqual(
      [...bad],
      [],
      `when-clauses gate on settings that don't exist (always false): ${[...bad].join(", ")}`
    );
  });

  test("every viewsWelcome entry targets a declared view id", () => {
    const viewIds = new Set<string>();
    for (const group of Object.values(pkg.contributes.views ?? {}) as {
      id: string;
    }[][]) {
      for (const v of group) viewIds.add(v.id);
    }
    const bad = ((pkg.contributes.viewsWelcome ?? []) as { view: string }[])
      .map(w => w.view)
      .filter(v => !viewIds.has(v));
    assert.deepStrictEqual(
      bad,
      [],
      `viewsWelcome content attached to nonexistent view ids (never shown): ${bad.join(", ")}`
    );
  });
});
