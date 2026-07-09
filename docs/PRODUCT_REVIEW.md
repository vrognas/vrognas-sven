# Sven Product Review — July 2026

## 1. How the features hang together today

### The coherent core

Three loops are genuinely closed, and they're the right three for centralized SVN:

- **Error-to-action chain** (`command.ts handleOperationError`): every failed op routes to its fix — auth→clear creds, lock conflict→steal, E155004→cleanup, out-of-date→update, conflict→resolve. This is the best cross-feature wiring in the codebase and the pattern everything else should copy. (INVENTORY)
- **Lock lifecycle**: needs-lock decorations → on-open lock prompt → chmod-readonly on unlock → commit auto-releases. Closed loop end to end. (INVENTORY)
- **Commit↔update coupling**: `commit.autoUpdate` (both directions), merge's "try updating first" retry, Remote Changes group with inline pull, B/S badges answering "where am I vs the server" at a glance. This directly models SVN's single-linear-history constraint. (INVENTORY)

The large-repo stack (sparse download, depth, parser guards) and the walkthrough/welcome onboarding are also real assets, if isolated.

### The dead-ends

The pillars are strong individually; the _seams_ are broken. Pattern across INVENTORY and FRICTION: the plumbing for the natural next step already exists, it's just not invoked.

| Dead-end                                                                                                                                                       | The unused neighbor                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Blame hover = plain string; status-bar "Show Commit" is literally an info toast (`blameStatusBar.ts:409` — comment says "delegate to log command", never does) | `repolog.goToRevision`, `openDiffCompared`, cached log messages                             |
| `goToRevision` toasts "Use Load more" for unloaded revs — exactly the old revisions blame produces                                                             | `fetchMore`/`fetchAll` machinery                                                            |
| Search commands dump unclickable text to tempsvnfs                                                                                                             | `repolog.filterHistory` does server-side `--search` with full tree UI                       |
| Conflict resolve = blind accept-option quickpick                                                                                                               | `.mine/.rOLD/.rNEW` sidecars on disk; diff commands; VS Code merge editor                   |
| Branch Changes computes mergeinfo + diff summarize; `sven.merge` fires blind without ever consulting it                                                        | The data is fetched, then thrown away                                                       |
| Locked-by-other file: silence on open, generic steal confirm                                                                                                   | `lockOwner` already parsed from status                                                      |
| Remote-changes counter click = immediate full `svn update`, no preview                                                                                         | Server-only commits already marked in repolog; `openChangeHead`, `pullIncomingChange` exist |
| Positron Connections `connect()` logs "Would execute" — a marketed pillar no-ops at its only action point                                                      | `sven.checkout` exists                                                                      |

## 2. Top 10 opportunities

Ranked by (workflow impact × SVN fit / effort). All connective tissue; almost no new silos.

**1. Blame → history pivot** — _small-medium_ — INVENTORY, GITLENS, TORTOISE, FRICTION (4/5 sources; the single most-corroborated gap). Trusted MarkdownString hover: message (already in `messageCache`, zero network), author/date, links to `repolog.goToRevision`, rev-vs-prev diff, copy rev. Wire status-bar "Show Commit" to the same. Add "Blame at r(N-1)" drill (TORTOISE's power-user chain; blame LRU already rev-keyed).

**2. Commit safety pack** — _small_ — OTHERSCM (#1647), FRICTION (3 items). (a) Warn on committing files with unsaved editors — worse in SVN, no amend. (b) Badge "changed on server" in commit quickpick via existing `hasRemoteChangeForFile` — lookup, not network. (c) On conflict-abort, preserve the typed message into `inputBox` and reveal conflicts group. (d) Run pre-commit update in the plain input-box path too (currently silently skipped).

**3. Informed lock UX** — _small-medium_ — OTHERSCM (P4 checkout-on-edit), FRICTION. Prompt on opening a file locked by another (currently silence); show owner/date/comment in the steal confirm (`lockOwner` already parsed); intercept save on read-only needs-lock files with Lock/Steal/Save As. Extends the already-closed lock loop to the contention cases. Uniquely centralized-SVN value.

**4. `goToRevision` auto-fetch** — _medium_ — FRICTION, INVENTORY. Bounded fetch-until-`lastRev <= target` loop (monotonic integers make termination exact — easier than git). This is the hinge that makes #1's links, itemlog's `gotoRepolog`, and #5's "show incoming" actually land. Unblocks three journeys with one fix.

**5. Incoming preview** — _small-medium_ — OTHERSCM (built-in Git sync indicator), FRICTION. Counter click → picker: Update now / Show incoming revisions (reveal first server-only repolog entry) / Show changed files. Per-file prompt gets "Update This File" (`pullIncomingChange` exists) and "Show Diff" (`openChangeHead` exists) — a 10GB-checkout user won't accept full update for one file.

**6. 3-way merge editor for conflicts** — _medium_ — OTHERSCM (#1632 upstream PR), TORTOISE ("#1 feels-primitive moment"), INVENTORY. SVN materializes the three inputs on disk; feed VS Code's merge editor, `svn resolved` on accept. Keep the quickpick as fallback. Also un-hide external diff tool from the conflicts menu.

**7. Local shelving** — _medium_ — OTHERSCM, TORTOISE (both independently converge on patch-based; both warn off `svn x-shelve`). Shelve = `svn diff [changelist]` → patch + revert; unshelve = apply. Builds on existing `patch`/`patchChangeList` commands. Fills SVN's biggest gap vs git; zero server round-trips.

**8. Cherry-pick / rollback from Repo History** — _medium_ — TORTOISE ("THE Tortoise log-dialog workflow"), INVENTORY. Context menu on revision nodes: merge `-c REV` into WC, revert `-c -REV`, revert-WC-to-N with `diff --summarize` preview. Completes what `itemlog.rollbackToRevision` already does for files. Mergeinfo records automatically; canonical audit-friendly SVN undo.

**9. History-surface unification** — _small_ — INVENTORY, FRICTION. Fold `searchLogByText/Revision` into `repolog.filterHistory` (same `svn log --search` primitive; deletes code, results gain full commit UI). Give Branch Changes a context menu reusing existing repolog handlers + workspace-relative labels. Add "Copy URL@REV" permalink (OTHERSCM #1655, GITLENS deep links) — pharma traceability, composes cached `info.url` + rev.

**10. Merge preview** — _medium-large_ — INVENTORY, FRICTION, TORTOISE. Before `repository.merge` runs, show eligible revisions via the mergeinfo query Branch Changes _already runs_, multi-select for `-c` cherry-pick, optional `--dry-run`, post-merge "N conflicts — Resolve" link. Mergeinfo eligible/merged sets are exact in SVN — a real advantage over git.

Free-standing quick fix, outside the ranking: wire Positron `connect()` to `sven.checkout` with the pre-filled URL and fix `checkDependencies()` — a marketed pillar currently no-ops (INVENTORY, small).

## 3. Explicitly rejected

- **Commit Graph / DAG topology** — SVN history is linear per branch; topology only exists via copy records. (GITLENS)
- **Interactive rebase, Launchpad** — no SVN analog; history is immutable centrally. (GITLENS)
- **Worktrees** — SVN idiom is a second working copy; at most a "checkout branch to sibling folder" command later. (GITLENS)
- **Full revision graph** — requires crawling `svn log -v` on `^/`; worst-case query pattern, contra the query-reduction ethos in the 2026-07 audit. (TORTOISE)
- **Native `svn x-shelve`** — experimental since 1.10, redesigned, never stabilized; patch-based only. (OTHERSCM, TORTOISE)
- **Full `git log -L` line-range history** — needs network revision-walking; blame-derived approximation maybe later, not now. (GITLENS)
- **Timeline API** — still proposed for third-party extensions (vscode#84297); track it, don't ship against it. (OTHERSCM)
- **WSL svn wrapper** — constant path translation in XML output; Remote-WSL sessions already work, document that instead. (OTHERSCM)
- **Contributors view, authorship CodeLens** — cheap-ish but low daily value / noisy; defer, don't reject forever. (GITLENS)
- **Commit amend** — impossible; the SVN-native substitute is revprop `svn:log` edit (small, server-gated), keep on backlog. (OTHERSCM #1629)

## 4. Next release theme: "Repo History is the hub"

Ship **#1 (blame pivot)**, **#4 (goToRevision auto-fetch)**, **#5 (incoming preview)**.

Why these three compound: #1 and #5 both create new routes _into_ Repo History (blame hover links, "show incoming revisions"), and #4 is what makes those routes reliable — blamed lines are old revisions, incoming commits are server-only entries, and today both dead-end in a toast. Together they convert the extension's best-built view into the answer surface for the two questions SVN users ask all day: "who/why is this line here?" and "what's about to hit my working copy?" All three reuse existing commands (`goToRevision`, `openDiffCompared`, `openChangeHead`, `pullIncomingChange`, `fetchMore`) — connective tissue only, no new subsystem, and FRICTION rates all three high-impact at small-to-medium effort.

Runner-up if one slips: swap #5 for #2 (commit safety pack) — same small effort, same reuse of the remote-changes cache.
