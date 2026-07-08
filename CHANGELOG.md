# Changelog

All notable changes to Sven are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [0.2.68] - 2026-07-08

Audit leftovers: three defects confirmed in earlier review passes but parked as out of scope.

### Fixed

- `SVN: Show Annotations (Blame)` was a dead end: it ran a remote HEAD blame and discarded the result (an info toast was all you got — a TODO from the original implementation). It now enables blame for the file, and the decorations render through the provider's shared caches. Programmatic calls with an explicit revision keep the direct fetch.
- Gutter heatmap colors were cached by revision number alone, so the first file blamed in a session froze the palette for every other file sharing those revisions — "newest = red" was wrong everywhere else, and theme switches served stale colors. The cache key now includes the revision's position in the file's range, the range size, and the theme lightness.
- Changing _any_ setting silently flipped the repository scan depth from 0 to 4 (`sven.multipleFolders.depth`'s package.json default) even with `sven.multipleFolders.enabled` off, arming recursive directory walks the disabled mode exists to prevent. Depth now applies only while the feature is enabled.

---

## [0.2.67] - 2026-07-07

The three deferred server-query proposals: immutable revision-pinned caching, blame keyed by its actual BASE revision, and history panels that stop paying for refreshes nobody sees.

### Changed

- **Immutable cache tier**: content and diffs pinned to a numeric revision are immutable in SVN's data model — `cat@REV` results and `svn diff -c REV` (fired per history-diff click, previously uncached) now hold for a day under LRU caps. `HEAD`/`BASE`/`PREV`/`COMMITTED`/date refs never qualify; log caches are intentionally untouched (their working-copy-path keys are branch-relative).
- **Blame keyed by resolved BASE revision**: `BASE` resolves to the file's actual base revision (local wc.db read) and the resolved revision is **pegged into the fetch**, so cached content always matches its key by construction. Entries hold for a day; a changed BASE — including external updates — produces a new key instead of a stale hit, and mixed-revision working copies get per-file-correct keys. `clearBlameCache` now clears the whole info cache (the old `resetInfoCache` only dropped the repo-root entry) so key resolution stays coherent after mutations.
- **History refresh deferred while hidden**: commit/update fired 2 fresh `svn log` calls even with the history panels closed — repoLog's explicit-fetch path fetched _specifically when hidden_. Both providers now defer the server refetch until reveal while still clearing the low-level log cache immediately (post-commit invariant kept).

### Fixed

- itemLog's "Load more" button had never paged: its command args were silently dropped and it reset the whole view instead. It now loads older history; repoLog load-more clicks bypass the hidden-defer.
- In-flight `svn cat`/`svn diff` results no longer repopulate caches cleared by repository disposal (`withCachedInFlight` owner guard).
- Test mock `TreeView` retains visibility listeners and exposes `_fireVisibility` (real API semantics).

---

## [0.2.66] - 2026-07-07

Server round-trips minimized without sacrificing freshness: the extension now keys "is my knowledge current?" on SVN's global monotonic revision number instead of wall-clock timers.

### Changed

- **Two-tier remote poll**: interval ticks run one constant-cost youngest-revision probe (`svn log -r HEAD:BASE --limit 1`) and skip the full-working-copy `svn status --show-updates` tree walk when nothing changed since the last full fetch, the incoming-changes UI is current, and no lock sweep is due. Locks change without revision bumps, so a full sweep still runs every 15 minutes and immediately after lock/unlock. Steady state per repo: 12 tree walks/hour become ~4 plus cheap probes. Known probe blind spots (working-copy members pinned below the root revision, `svn:externals` sources) are bounded by the sweep.
- **Focus-gated polling with error backoff**: unfocused windows skip poll ticks entirely and catch up ~immediately on refocus (respecting backoff); consecutive failures back off exponentially instead of hammering an unreachable server.
- **Branch-changes pipeline gated on repo revision**: the 4-round-trip pipeline (`log --stop-on-copy`, `mergeinfo`, `info URL`, `diff --summarize`) previously re-ran on every status burst while the view was visible (~80 calls/hour); it now runs only when a commit/merge lands on either branch. The copy point is cached per branch URL (30-min TTL, cleared on switch); results are keyed by branch URL + repo youngest revision with a generation counter against stale write-backs.
- **Server-knowledge tracker**: every server response that carries revision information (probe, update result, commit response) feeds a per-repo monotonic record, so features reuse observations instead of re-asking the server.

### Fixed

- The `hasRemoteChanges` probe used an ascending `BASE:HEAD` range, so `--limit 1` returned the _oldest_ revision; it also over-reported (the range includes BASE itself). Now descending, returning the youngest revision, with `hasChanges` = youngest > BASE.
- The poll gate compares revision identity against the last full fetch rather than `youngest > BASE`, which lies in mixed-revision working copies (own commits bump only committed nodes) and could persistently hide colleagues' incoming changes after a partial commit.
- A poll-decided `svn status --show-updates` can no longer be silently swallowed by the 1-second model cache while the lock sweep is stamped done.

---

## [0.2.65] - 2026-07-07

QuickDiff no longer phones home: opening a tracked file used to fire a remote `svn list <URL>` round-trip just to stat the virtual BASE original.

### Changed

- `SvnFileSystemProvider.stat` makes no remote calls. mtime comes from local `svn info` (wc.db, 2-min cache) — the BASE last-changed date moves exactly when commit/update change BASE, preserving VS Code's reload signal for quickdiff originals and log/patch documents. Revision-pinned URIs (immutable content) get a constant stat with no svn call. Size is reported as 0: it isn't available locally, and the previously fetched HEAD size already disagreed with the displayed BASE content whenever the server was ahead.
- Test mock `Uri` now carries `query` through `with()` (real API semantics); the old mock dropped it, so `fromSvnUri` silently fell back to defaults in tests.

---

## [0.2.64] - 2026-07-07

Maintainability/DRY pass over the 0.2.63 blame series; fixes the staleness gaps the review surfaced.

### Fixed

- Status bar refreshes after commit/update/switch/merge even when the cursor stays on the same line: it now subscribes to each repository's `onDidRunOperation` (the same-line skip previously pinned pre-op blame indefinitely).
- E155007 (non-working-copy) blame failures are silent again, matching the removed `svn info` pre-check's behavior — no more log spam and 30s re-spawn loop for detached/shallow-checkout files.
- A gated over-limit file recovers once it shrinks below the limit: status bar `lastLineKey` is armed only by a successful render, so gates, failures, and hidden states re-evaluate on same-line events.
- Dispose-path cache clearing delegates to `clearBlameCache()`, so the generation bump blocks in-flight write-backs on every clear path.
- Per-revision commit-message logs are untargeted again: a single-revision log costs the same either way, and targeting misses revisions from replaced/renamed ancestor paths — the exact case where the targeted range log fails and this fallback runs. Only `logBatch` keeps the file target.

### Changed

- `BLAME_INVALIDATING_OPERATIONS` in `util.ts` is the single source of truth for which operations drop blame caches (previously encoded divergently across `Repository.run()`, the provider, and `svnRepository` methods).
- One shared `blameConfiguration.getBlameSizeGate()` replaces the size-check predicate triplicated across decorations, cursor path, and status bar; `lineKeyFor()` is the single same-line-key definition.
- Fake-SvnRepository test fixture consolidated into `src/test/unit/svn/helpers/fakeSvnRepository.ts` — a drifted copy (missing `_blameGeneration`) had made an invalidation assertion pass for the wrong reason.

---

## [0.2.63] - 2026-07-07

Blame performance overhaul: far fewer svn subprocesses, no fetches when blame isn't wanted, and post-commit blame no longer stale.

### Fixed

- `sven.blame.autoBlame` is now actually honored — it had zero call sites, so blame auto-fetched on every tracked-file open regardless of the setting (the "Data Science" recommended profile's `autoBlame: false` did nothing). Default behavior unchanged (`true`); with `false`, blame stays off per file until enabled via the blame commands.
- Post-commit/update/revert/switch/merge blame is no longer stale for up to 5 minutes: the repo blame cache is cleared on mutating operations (`resetBlameCache` previously had zero callers; the 5-min TTL remains as backstop for external svn activity).
- Blame cache entries for non-active visible editors could never hit (version pinned to `-1` from `window.activeTextEditor`), re-fetching on every selection event. Version now comes from the editor that triggered the lookup.

### Changed

- Status bar no longer blames files the provider refuses: over-limit CSVs and files over `largeFileLimit` are skipped, same-line selection events short-circuit before the blame pipeline, selection events from non-active editors are ignored, and the double 150ms debounce is gone. The provider's cursor path gets the same silent size gates.
- `SvnRepository.blame`: cache check moved outside the sequentialize queue (cache hits no longer wait behind an in-flight network blame of another file), concurrent callers for the same file share one fetch, and non-transient failures (binary/unversioned/invalid revision/parse) are negative-cached for 30s — a failing huge file no longer re-spawns `svn blame` on every debounced cursor pause.
- Cold blame of a clean file no longer pays a redundant `svn info` pre-check (blame's own error handling already skips unversioned files silently) — halves cold-path subprocess count.
- Inline commit-message prefetch passes the blamed file to `svn log`, so the server returns only that file's history instead of every revision in the checkout between the file's min and max blamed revisions.
- `Operation.Blame` and `Operation.List` no longer flash the SCM progress spinner (background reads triggered by cursor movement and quickdiff stats).
- Post-review hardening: `BlameProvider` subscribes to `onDidRunOperation` and drops its version-keyed cache on mutating ops (a commit doesn't bump `document.version`, so repo-level invalidation alone never reached decorations); `clearBlameCache` also drops in-flight fetches and bumps a generation counter so a blame that started pre-commit can't repopulate the cleared cache; cache clearing moved to `finally` (failed update/commit may still mutate the WC); `skipCache=true` forces a fresh fetch again; status bar same-line skip no longer pins transient failures — only definitive outcomes suppress retries.

---

## [0.2.62] - 2026-05-15

CSV diff gate no longer blocks the workflow with a modal.

### Changed

- Clicking an over-limit CSV file in the Source Control Changes pane now opens the file immediately (no `svn cat` for the BASE side) and posts a non-blocking info toast `CSV diff skipped (X MB > 1 MB). Adjust 'sven.diff.csvSizeLimitMB' to change.` with a single `Open Diff Anyway` button. Clicking the button triggers `vscode.diff` retroactively. The old modal with `Open Diff Anyway` / `Open File` / `Cancel` was disruptive and is gone.

---

## [0.2.61] - 2026-05-15

Bundle slimmed by ~53% (vsix 378 → 180 KB compressed; `dist/extension.js` 958 → 451 KB) by dropping `@vscode/iconv-lite-umd` (506 KB of pre-bundled encoding tables) in favor of Node's built-in `TextDecoder`. Modern Node ships with full ICU, so all common encodings (UTF-8/16, ISO-8859-x, windows-12xx, GBK, Big5, Shift_JIS, EUC-KR/JP, KOI8-R, macintosh) are still supported. Exotic encodings outside ICU now fall back to UTF-8 with a console warning instead of decoding silently.

### Changed

- New `src/util/textCodec.ts` wrapper exposes `decode`/`encode`/`encodingSupported`. Call sites in `svn.ts`, `svnRepository.ts`, `temp_svn_fs.ts` migrated. `vscodeModules.ts` and the `iconv-lite.d.ts` ambient type are removed.
- `textCodec` includes a label-normalization layer so encoding names produced by chardet and the previous iconv-era code path (e.g. `"UTF-16 LE"` with a space, `"windows1252"` dash-stripped, iconv aliases `cp866`/`cp950`/`cp936`) keep working against `TextDecoder`. `encoding.ts` is simplified — the dash-stripping return path and the `CHARDET_TO_ICONV_ENCODINGS` alias map are gone; canonicalisation now lives in one place.

### Removed

- `@vscode/iconv-lite-umd` dependency.

### Also bundled in this release

- The `.vscodeignore` fix that stopped `.remember/logs/` (300 KB of dev memory logs) from being published to users.

---

## [0.2.60] - 2026-05-15

Aggressive size/line gates for CSV-like files to stop large `.csv`/`.tsv` from stalling the editor on diff or blame.

### Added

- **`sven.blame.csvExtensions`** (default `[".csv", ".tsv"]`) and **`sven.blame.csvLineLimit`** (default `500`). When the file's extension matches and line count exceeds the limit, blame is skipped with a one-shot warning naming the relevant settings. Runs ahead of the generic `largeFileLimit`.
- **`sven.diff.csvExtensions`** (default `[".csv", ".tsv"]`) and **`sven.diff.csvSizeLimitMB`** (default `1`). Above the limit, opening a change shows a modal: `Open Diff Anyway` (default), `Open File`, or cancel. The `Open File` and cancel paths skip `getLeftResource` entirely, so no `svn cat` is triggered for the BASE side.

---

## [0.2.59] - 2026-05-14

Same content as the never-shipped 0.2.58, plus a build fix: the unused `formatErrorMessage` wrapper kept around "for test compatibility" tripped TypeScript's `noUnusedLocals` in CI (the test reaches it via `as any`, which is invisible to the unused-private check). Dropped the wrapper; updated the test helper to call `formatErrorMessageFromContext` after building the context locally.

### Performance

- **`handleOperationError` and `handleRepositoryOperation` no longer rebuild the `ErrorContext` twice per error.** Each used to call `formatErrorMessage(error, ...)` (which internally built the context via `getErrorContext`) and then call `getErrorContext(error)` _again_ a line later. Building the context runs `sanitizeStderr` (13 sequential regex passes over the full stderr) plus `.toLowerCase()` on the combined string. The single remaining formatter, `formatErrorMessageFromContext(context, fallbackMsg)`, takes a pre-built context so callers share it.

### Audited, no change needed

- **`parser/logParser`, `infoParser`, `listParser`, `diffParser`**: minimal transforms, all of the per-call cost is in `XmlParserAdapter.parse` (which is already lazy-singleton-cached after v0.2.55).
- **`BlameProvider.applyIconDecorations`**: disposes icon decoration types per render — intentional, since each file's color palette differs and VS Code's `TextEditorDecorationType` leaks if not disposed. Per-render cost (~10–50 disposals + recreates) is fine on the file-open path; cursor moves skip this entirely via `updateInlineDecorationsForCursor`.
- **`BlameProvider.getRevisionColor`**: cached in `revisionColors` map. HSL→hex math runs once per unique revision, then served from cache.
- **`generateColorBarSvg`**: cached in `svgCache` by color string. Each unique color runs `Buffer.from(...).toString("base64")` once.
- **`includesAny` in error detectors**: each detector does a small `.some(needle => text.includes(needle))` over ≤6 tokens. Only runs on the error path (rare).

---

## [0.2.57] - 2026-05-14

Deeper perf audit of the gutter-blame render loop.

### Performance

- **`BlameProvider` decoration loops no longer re-read config + re-allocate `rgba(...)` color per line.** `createAllDecorations`, `updateInlineDecorationsWithMessages`, and `updateInlineDecorationsForCursor` all looped over blame lines while calling `blameConfiguration.isGutterEnabled()`, `isGutterTextEnabled()`, `isInlineEnabled()`, `isInlineCurrentLineOnly()`, `shouldShowInlineMessage()`, and `getInlineOpacity()` inside the loop — plus interpolating the `rgba(127, 127, 127, X)` string per line. For a 1000-line file that was ~6000 redundant config reads and 1000 redundant string allocations per render. All hoisted to locals before the loop.

### Audited, no change needed

- **`security/errorSanitizer.sanitizeString`** — 13 sequential regex passes, but error logging is rare relative to status refreshes, and individual error strings are short.
- **`isSanitizationDisabled` per-call config read** — same path as above; rare.
- **`BlameProvider.formatInlineText` per-call config reads** — kept as-is to avoid signature change that would churn 2 existing tests; the configs are themselves cheap `Map.get`s and the template result is cached at the `compileTemplate` layer.
- **`util/globMatch`** — only used on user-triggered ignore/pattern commands, not status hot path.

---

## [0.2.56] - 2026-05-14

Deeper perf audit of utility layer (uri/cache/decorator/fs/blame-state).

### Performance

- **`formatBlameDate` is now memoized.** Gutter blame renders call this once per line: a 1000-line file with 50 unique commit dates was reparsing the same ISO 8601 string ~950 times per render — each call constructed a fresh `Date` and ran `toLocaleDateString`/`getRelativeTime`. Bounded cache (1024 entries, 60s TTL, FIFO eviction) keyed by `${format}|${dateStr}` so absolute/relative don't collide and the "relative" form never visibly drifts.

### Audited, no change needed

- **`LRUCache` per-entry `setTimeout` for TTL**: for caches of ≤500 entries, the per-set `clearTimeout`+`setTimeout` cost is sub-microsecond — well below the noise floor of the SVN operations the cache fronts. Lazy expiration would be cleaner but risks broader test churn for a marginal win.
- **`uri.ts` JSON parse/stringify per URI**: `fromSvnUri` runs on every diff stat/readFile, but the JSON payload is small (~50 bytes); caching by Uri identity is unsafe (VS Code re-instantiates URI objects).
- **`SvnRI` getters**: already `@memoize`-d at the instance level.
- **`decorators.ts` (`@memoize`/`@throttle`/`@debounce`/`@sequentialize`/`@globalSequentialize`)**: lean, allocation-conscious, no per-call work beyond the necessary.
- **`temp_svn_fs` in-memory FS**: only touched by historical-diff command paths, not status hot path.
- **`util/batchOperations.executeBatched` sequential chunks**: correct — SVN locks at WC level, so true parallel chunks would risk lock contention.
- **`blameStateManager` / `blameConfiguration` accessors**: every call is a `Map.get` (state) or VS Code `WorkspaceConfiguration.get` (config). No SVN calls, no allocations.

---

## [0.2.55] - 2026-05-14

Deeper perf audit of the parser, helpers, and contexts layer.

### Performance

- **`XmlParserAdapter` now reuses a single `XMLParser` instance.** Previously, every SVN result (status refresh, blame, log, info) constructed a fresh `XMLParser` with ~20 configuration options. The parser is stateless after construction, so a lazy singleton works just as well and removes that allocation from the hot path.
- **`isTrunk` memoizes its compiled regex.** Called from `HasBranch.checkHasBranch` once per repository per change event; previously rebuilt the `RegExp` from `layout.trunkRegex` on every call. Cache key is the config value pair, so test mocks of `configuration.get` still take effect cleanly.
- **`BlameIconState` no longer dynamic-imports `Status` per `updateIconContext` call.** Moved to a top-level ES import — the dynamic form was a legacy workaround that survived after the circular-dependency it avoided was resolved. Also added a same-value guard so `setContext` (cross-IPC) is skipped when neither blame-active nor untracked-file context changed; `updateIconContext` fires on every editor change + status refresh, and most invocations are no-ops in steady state.
- **`BlameStatusBar.getBlameData` got the same `Status` import fix** — sister file, same legacy dynamic-import pattern.

### Audited, no change needed

- **`XmlParserAdapter` `performance.maxXmlTags` per-call config read**: small relative to parse cost; caching would conflict with the security test's `vi.spyOn(configuration, "get")` mock approach.
- **`lineMapper.computeLineMapping` LCS O(N×M)**: only an issue for very large (>5k-line) files, and the result is cached per blame load. Rewriting to e.g. patience-diff would be a substantial change for a niche bottleneck.
- **`HasBranch` / `OpenRepositoryCount` / `CheckActiveEditor` `setContext` calls**: already debounced 100ms, values are primitives. Dedup possible but marginal.

---

## [0.2.54] - 2026-05-14

Deeper next-layer perf audit — focused on tree providers, FS provider, and the SVN spawn layer.

### Performance

- **`BranchChangesProvider` now skips refresh when its view is hidden.** Previously, every `onDidChangeRepository` event (fires on file save, lock change, status refresh, etc.) triggered `getChildren` → `repo.getChanges()`, which spawns **3+ SVN commands per repo** (`svn log --stop-on-copy`, `svn mergeinfo`, `svn info`, `svn diff --summarize`). Even with the panel collapsed, every status update paid this cost. Now: `registerTreeDataProvider` → `createTreeView`, change events are gated on `treeView.visible` and debounced 1s; a single refresh fires on `onDidChangeVisibility` (hidden→visible) so stale data is updated when the user re-opens the panel. Same pattern as `ItemLogProvider` (v0.2.52) and `RepoLogProvider`.
- **`Svn.executeProcess` no longer re-reads `auth.commandTimeout` per command.** Cached with 5s TTL + `onDidChange` invalidation, mirroring the existing `authConfigCache`. Removes a workspace-config read from the SVN spawn hot path.

### Audited, no change needed

- **`SvnFileSystemProvider.readFile`**: `svn cat` already deduped via `SvnRepository._catCache` (LRU 50, 30s) + `_catInFlight`. Concurrent diff opens for the same URI+rev share a single spawn.
- **`SvnFileSystemProvider.stat`**: 1-min stat cache + pending-request dedup already in place; invalidated on repository change.
- **`SvnFileDecorationProvider.provideFileDecoration`**: every cache helper called (`hasNeedsLockCached`, `getLockStatusCached`, `getEolStyleCached`, `getMimeTypeCached`, `isInsideUnversionedOrIgnored`) is a sync `Map.get`. Zero SVN calls per decoration request — already optimal.
- **`SparseCheckoutProvider`**: only subscribes to `onDidOpenRepository`/`onDidCloseRepository`, not `onDidChangeRepository`. Not in the status-refresh hot path.
- **`RepositoryFilesWatcher`**: 300ms throttle on FS events plus native `fs.watch` fallback only when the workspace doesn't include the repo root. Already tuned.

---

## [0.2.53] - 2026-05-14

### Refactored

- **Removed `BlameStatusBar.blameCache`** — the local 5-min TTL cache layered on top of `SvnRepository._blameCache` (also 5-min TTL) was a redundant second cache. Worse: the two `onDidChangeTextDocument` / `onDidSaveTextDocument` listeners that invalidated it on local edit/save were over-eager (a local edit doesn't change the BASE blame), so they were forcing re-fetches that just hit the underlying cache anyway. With the local cache and listeners gone, `getBlameData` is a thin pre-check + `repository.blame()` call; the cache hit/miss decision now lives in exactly one place (`SvnRepository._blameCache`).

Did not touch `BlameProvider`'s local cache: it's keyed by URI + document version and ties into `lineMappingCache`, so consolidating it would have needed a broader refactor of both consumers' line-mapping logic. The test suite is also tightly coupled to `mockRepository.blame` being called directly. Investigated a unified `Repository.getBlameForFile(uri)` entry-point but it broke ~20 tests that mock the call surface; the narrower cleanup here covers the actual duplication without disturbing the BlameProvider contract.

---

## [0.2.52] - 2026-05-14

Follow-up perf pass focused on critical user-interaction paths (save, tab switch, SCM click, hover).

### Performance

- **`ItemLogProvider` no longer fires `svn log` on tab switch while the history view is hidden.** Previously, every `onDidChangeActiveTextEditor` (debounced 100ms) called `refresh()` → `fetchMore()` → `svn log` for the new active file, regardless of whether anyone was looking at the panel. `RepoLogProvider` already had this guard; ItemLog now matches. To keep the panel coherent when the user does open it back up, an `onDidChangeVisibility` listener fires one refresh on transition to `visible=true`.

### Audited, no change needed

- **File-save path**: ~300ms to status refresh; single `svn status` + 1 conditional `svn blame` if the blame decoration is active. The earlier perf passes (`getPropertyChanges` cache, watcher throttle 300ms, debounce 200ms, force-refresh grace period) already made this near-optimal.
- **File open / tab switch**: `BlameProvider` and `BlameStatusBar` both subscribe to `onDidChangeActiveTextEditor` and call `repository.blame(file)`. Although they maintain separate local LRUs on top, the underlying `SvnRepository._blameCache` is shared, so the second caller within 5 min hits cache — only one `svn blame` spawn per file+revision. Local-cache duplication isn't a hot bottleneck.
- **`FileDecorationProvider.provideFileDecoration`** (called many times by VS Code for Explorer, tabs, breadcrumbs): all reads are synchronous cache lookups (`hasNeedsLockCached`, `getLockStatusCached`, `getEolStyleCached`, `getMimeTypeCached`) backed by background-warmed caches. Zero SVN calls per decoration request.
- **SCM panel actions** (stage/unstage/revert/refresh/commit): every one is already at minimum SVN command count for its operation. Optimistic UI + grace period + batching all in place.
- **`refreshAllPropertyCaches`**: deduped via `_propertyRefreshInFlight` with explicit test coverage.

---

## [0.2.51] - 2026-05-14

Performance pass triggered by a deep audit for unnecessary SVN calls and bottlenecks.

### Performance

- **`svn diff --properties-only` per file per status refresh, eliminated.** `SvnRepository.getPropertyChanges(filePath)` is now backed by a 30s LRU cache (500 entries) and an in-flight `Promise` dedup map, via the existing `withCachedInFlight` helper. `StatusService.fetchPropertyChanges` was the worst offender: on every status refresh (save, optimistic stage/unstage, watcher event, polling) it iterated every file with property changes and ran one `svn diff --properties-only <path>` per file in 5-parallel chunks. With this cache, the typical refresh on a working copy with stable property state spawns **zero** `svn diff` calls. The cache is dropped wholesale by `Repository.updateModelState` whenever `forceRefresh=true`, so post-mutation refreshes (Commit / Revert / PropertyChange / Update / CleanUp etc.) still see fresh diff output. Without explicit invalidation a 30s TTL would already catch this, but explicit drop on forceRefresh keeps the user-perceived latency window tight.
- **`getInfo()` cache hits no longer queue behind concurrent fetches.** The `@sequentialize` decorator on `SvnRepository.getInfo` wrapped the entire method including the cache check, so N concurrent callers for an already-cached path executed serially even though all of them only needed a `Map.get`. Split the method: public `getInfo()` runs the LRU lookup eagerly and only falls into the sequentialized fetch on a true miss; the private `_doGetInfoFetch` carries `@sequentialize` and double-checks the cache after acquiring the lock in case a previous queued fetch already populated it. Pre-existing single-fetch semantics on cache miss preserved.
- **`onFSChange` debounce 500ms → 200ms.** FS events already pass through `RepositoryFilesWatcher`'s 300ms throttle (`util.ts:throttleEvent`); stacking a 500ms debounce on top added latency for no extra coalescing benefit (the throttle already collapses sub-300ms bursts). The save-to-status-refresh path now starts ~300ms sooner. 200ms is enough debounce to coalesce the second wave of follow-up FS events that arrive after the throttle's leading edge.

### Refactored

- **Removed redundant `clearLogCache()` after commit.** `Repository.commitFiles` was wholesale-clearing the 50-entry log LRU right before dispatching `sven.repolog.fetch` / `sven.itemlog.refresh`. Both refresh handlers already call `clearLogCache()` themselves via `explicitRefreshCmd(shouldClearCache=true)`, and the cached entries for past revisions are immutable anyway. One redundant cache-clear gone.

### Investigated, no change

- **"Neither" operations (`Merge`, `SwitchBranch`, `Rename`, `Resolved`, `NewBranch`)**: not in `isReadOnly` and not in `FORCE_REFRESH_OPERATIONS`. The author's comment in `util.ts` documents that these handle their own grace via `onFSChange`'s `isRunning(Merge|SwitchBranch|Update)` skip. Verified: `onFSChange` does drop watcher events during these ops, and `Repository.run` always issues a post-op `updateModelState` (just without `forceRefresh`, which means a brief 2-second-cache window before the watcher events that fire as the op exits trigger a fresh refresh). Latency is bounded; behaviour matches author intent. Left as documented.
- **`BlameProvider.messageCache` "cleared on document close"**: false alarm from the audit. Line 308's `clearCache(uri)` deletes URI-keyed entries from `blameCache`/`lineMappingCache`/`inFlightMessageFetches` but never touches `messageCache`. Revision-keyed messages persist across document closes (bounded by `evictMessageCache()` 25%-evict-at-MAX policy).

---

## [0.2.50] - 2026-05-13

### Fixed

- **`isTrunk` when `layout.trunkRegex` is unset**: previously interpolated `undefined` into the regex (`/(^|\/)(undefined)$/`) and silently matched paths ending in the literal string "undefined". Now mirrors `getBranchName`'s early-return when the layout config is empty.

### Refactored

- **Dropped dead `Resource._renamedAndModified`**: the field was hardwired to `false` at the only construction site (`StatusService.categorizeStatuses`), so every branch that read it (`"RM"` letter, `"+ Modified"` tooltip suffix) was unreachable. Removed the constructor parameter, the getter, the `IFileStatus` field, the `false` literal passed at the call site, and simplified `letter`/`tooltip` accordingly.
- **Dropped dead `Resource.faded`** getter (always returned `false`) and the `faded` field on the `decorations` object. `SourceControlResourceDecorations.faded` is optional in the VS Code API, so omitting it is equivalent.
- **Dropped four unused typed config accessors** from `Configuration`: `sourceControlIgnore`, `hideUnversioned`, `countUnversioned`, `logAuthorColors`. All four had zero callers; the same settings are read directly via `configuration.get<>()` throughout the codebase. `countUnversioned` also had a different default (`true`) than every inline caller (`false`), which would have been a footgun the moment anyone adopted the wrapper.
- **Renamed `commitHelper`'s `CommitFlowResult` → `CommitMessageFlowResult`** to disambiguate from the unrelated `CommitFlowResult` exported by `services/commitFlowService.ts` (different shape: `selectedFiles` vs `commitPaths`).

---

## [0.2.49] - 2026-05-13

### Refactored

- **`CommitFlowService` cleanup**: removed `getRecentScopes`, which duck-typed `Repository` for a method that doesn't exist — it always returned `[]` and made the `showScopeStep` placeholder branch dead. Inlined the one-line `runSimpleFlow` indirection. Replaced the `while (!confirmed) { … }` loop in `runConventionalFlow` (which always returned from inside) with a `for (;;)` form so the unreachable trailing `return undefined` could be removed without changing flow.
- **`PreCommitUpdateService` conflict detection**: now prefers the structured `svnErrorCode` field (`E200024` / `E155015`) over substring matching on `error.message`, and uses named constants `MERGE_CONFLICT_CODE` / `COMMIT_CONFLICT_CODE` instead of bare literals. Substring/`includes("conflict")` is retained as a fallback for non-`SvnError` throws. Codes are inlined as local literals rather than importing `svnErrorCodes` from `../svn` — the latter would pull `configuration.ts` (and its `vscode.EventEmitter` dependency) into the module's import graph and break three test files whose `vscode` mock doesn't cover the full chain.

---

## [0.2.48] - 2026-05-13

### Fixed

- **`SourceControlManager.open()` repository leak**: when `blameProvider.activate()` (or any subsequent setup) threw, the catch path disposed the listeners and `BlameProvider` but never called `repository.dispose()`. The repository's watchers, in-flight SVN child processes, and the auth/grace-period timers all leaked. Catch now disposes the repository together with the other failure-path resources. The normal-teardown dispose closure is unchanged (and still fires `onDidCloseRepository`, which is correct only on graceful close — never on failed open).

### Refactored

- **`ResourceGroupManager.isInsideUnversionedOrIgnored`**: four near-identical loops (exact-match and folder-prefix-match, once over `_allUnversioned` and once over `_ignored`) collapsed into two loops sharing a single `matchesPathOrFolder` helper. Behaviour unchanged — `_allUnversioned` still wins over `_ignored`.
- **`ResourceGroupManager.moveToStaged`**: the three filter-and-collect blocks for `_changes`, `_unversioned`, and each `_changelists` entry consolidated into a single `extractMatching(group, pathSet, collector)` private method. The dedup-on-collect check is now uniform across all three (previously only present on two), which is harmless: `_changes` is drained first, so a resource it contributes can't appear again in a later group.
- **`StatusService.categorizeStatuses`**: dropped the unused `_config: StatusConfig` parameter. It was kept "for API stability" but the method is private, and `ignoreList` filtering moved to `ResourceGroupManager` some time ago.

---

## [0.2.47] - 2026-05-13

### Refactored

- **`RepositoryFilesWatcher`**: trimmed public surface from 12 events to 3. Only `onDidAny`, `onDidSvnAny`, and `onDidWorkspaceDelete` had external consumers; the other 9 (`onDidChange`, `onDidCreate`, `onDidDelete`, `onDidWorkspaceChange`, `onDidWorkspaceCreate`, `onDidWorkspaceAny`, `onDidSvnChange`, `onDidSvnCreate`, `onDidSvnDelete`) were unused. Constructor logic compacted accordingly; `.svn/` and `.svn/tmp` regexes hoisted to module constants.

---

## [0.2.46] - 2026-05-13

### Performance

- **Mark `List`, `Blame`, `Patch` as read-only operations** in `isReadOnly()`. These pure-read SVN commands no longer trigger a post-operation `updateModelState` (→ `svn stat`) as a side effect. Eliminates one wasted `svn stat` per editor open (after `svn list` from `svnFileSystemProvider.stat`), per blame fetch, and per patch generation. Opening an SVN-tracked file now runs 3 parallel commands (`svn log`, `svn cat -r BASE`, `svn list`) instead of 3 parallel + 1 serial `svn stat`.

---

## [0.2.45] - 2026-05-13

### Changed

- **Bumped engine floor**: `engines.vscode` `^1.108.0` → `^1.109.0`; `engines.positron` `^2025.11.0` → `^2026.04.0`. Positron 2026.04.x and 2026.05.x both ship Code-OSS 1.109.2, so the new floor matches all current Positron releases. Drops support for Positron 2025.11.x through 2026.03.x (~5 months of older releases).
- `@types/vscode` aligned to `~1.109.0`.

---

## [0.2.44] - 2026-05-13

Performance + code-quality release. Substantially fewer SVN command spawns per user action, especially on large working copies. No user-visible behaviour changes — same SVN semantics, less churn.

(Tag `v0.2.43` was created but its publish workflow failed at the `tsc` build step on pre-existing type errors in `setDepth.ts` / `sparseCheckoutProvider.ts`. v0.2.44 fixes those by splitting `DepthQuickPickItem` into a wide form for the checkout multi-select picker and a narrow `SvnDepthQuickPickItem` for the SVN-only depth pickers. Master CI used esbuild and silently tolerated the union mismatch; the publish workflow uses real `tsc` and caught it.)

### Performance

- **Staging a file**: 6 SVN commands → 1 (`svn changelist`). The reflex `svn info` / `svn stat` / `svn proplist` / `svn list` cascade that fired on `.svn/wc.db` writes is now suppressed by the watcher grace period that the optimistic stage/unstage path was previously skipping. (0.2.34, 0.2.35)
- **Saving files**: 3× concurrent `svn proplist -R -v .` (recursive over the whole working copy — the heaviest cache-refresh command) collapses to 1. `refreshAllPropertyCaches` now has in-flight dedup. (0.2.36)
- **Opening a diff**: 2× remote `svn list <url>` → 1; 2× `svn cat` → 1. `svnRepository.list` gained a 30s URL-keyed LRU cache; `prepareCatArgs` normalizes the default revision so working-copy and `-r BASE` callers share a cache key. (0.2.37, 0.2.38)

### Internal

- Collapsed duplicate stage methods; batched unstage UI notifications; extracted `withCachedInFlight` helper; replaced a 13-clause operation-list boolean chain with a `Set`; inlined 8 error-detector wrapper methods in `Command`; removed dead overloads and module-private leaks. (0.2.34, 0.2.39–0.2.43)

See the per-version blocks below for the full detail.

## [0.2.43] - 2026-05-13

Tag-only release — publish workflow failed at the `tsc` build step on pre-existing type errors in `setDepth.ts` / `sparseCheckoutProvider.ts`. Re-released as 0.2.44 with the fix. Substantive notes for this release are inlined into the 0.2.44 entry above.

### Refactored

- Removed `needsFormatCleanupFromFullError` and `FORMAT_CLEANUP_TOKENS` — literal aliases of `needsCleanupFromFullError` and `CLEANUP_ERROR_TOKENS`. The token-set alias claimed to enable independent divergence later (YAGNI). Single caller in `formatErrorMessage` now uses `needsCleanupFromFullError` directly.

---

## [0.2.42] - 2026-05-13

### Refactored

- `Command.handleOperationError` had 6 `this.needsX(error)` calls — each a 2-line wrapper that re-extracted `fullError` from the error context. Net effect: 6× redundant string extraction + `sanitizeStderr` per error. Now extracts `fullError` once and calls the `needsXFromFullError(fullError)` helpers directly, matching the already-good pattern in `formatErrorMessage`.
- Same treatment for `Command.handleRepositoryOperation`'s `needsNetworkRetry` call.
- Removed 8 unused private wrapper methods (`getFullErrorString`, `needsCleanup`, `needsUpdate`, `needsConflictResolution`, `needsAuthAction`, `needsNetworkRetry`, `getLockErrorType`, `needsOutputAction`) and the now-unused `LockErrorType` import. Net ~80 lines removed.

---

## [0.2.41] - 2026-05-13

### Refactored

- `Repository.run()`'s 13-clause `forceRefresh` `||` chain replaced with `FORCE_REFRESH_OPERATIONS: ReadonlySet<Operation>` constant in `util.ts`. Same behaviour, O(1) lookup, easier to scan and extend. Co-located with `isReadOnly` for cross-reference.

---

## [0.2.40] - 2026-05-13

### Refactored

- **`unstageOptimistic`**: dropped the legacy `(files, targetChangelist?)` overload — no caller used it after the v0.2.34 batching refactor. Single signature `(groups: Map)` now.
- **`stageHelper.ts`**: `getAffectedChangelists`, `buildOriginalChangelistMap`, `warnAboutChangelists` are now module-private (were leaky exports — only `prepareStaging` used them internally).
- **`commands/stage.ts`**: replaced the `stageOperation` closure parameter with a simple `expand: boolean` — closure was abstracting a 1-line difference between `stageOptimistic(paths)` and `stageOptimistic(paths, { expand: true })`.

---

## [0.2.39] - 2026-05-13

### Refactored

- Extracted `withCachedInFlight<V>` utility — the cache+in-flight dedup pattern used by `svnRepository.list()` and `svnRepository.showBufferWithArgs()` was duplicated verbatim (~10 lines each). Call sites collapse to 4 lines.
- Split `src/test/unit/helpers/stageHelper.test.ts`: tests for `Repository` moved to `src/test/unit/repository/staging.test.ts`; tests for `svnRepository` moved to `src/test/unit/svn/repositoryCaches.test.ts`. `stageHelper.test.ts` now contains only stageHelper tests, matching its filename.

---

## [0.2.38] - 2026-05-13

### Fixed

- **Duplicate `svn cat` on diff open**: `svnFileSystemProvider.readFile` calls `showBuffer(fsPath)` with no revision (SVN defaults to BASE for working-copy paths → `svn cat <file>`); `BlameProvider.computeLineMapping` calls `show(fsPath, "BASE")` (→ `svn cat -r BASE <file>`). Different exec args meant the in-flight dedup didn't unify them — two SVN reads for identical BASE content. Now `prepareCatArgs` normalizes `revision=undefined` to `"BASE"` for working-copy paths, and an LRU `_catCache` (50 entries, 30s TTL) lets sequential callers share results, not just concurrent ones.

---

## [0.2.37] - 2026-05-13

### Fixed

- **Duplicate remote `svn list`**: opening a diff produced two svn-scheme URIs (different `rev=` params) that both resolved to the same fsPath. `svnFileSystemProvider.stat` cache is keyed by URI, so each fired its own `repository.list(fsPath)` → remote `svn list <URL>`. `svnRepository.list` had no cache. Added URL-keyed LRU cache (30s TTL, 200 entries) + in-flight Promise dedup, so concurrent and short-window-sequential callers share one network call.

---

## [0.2.36] - 2026-05-13

### Fixed

- **Save lag — proplist dogpile**: `refreshAllPropertyCaches` had no in-flight dedup. `propertyCacheExpiry` is only pushed forward AFTER `getAllProperties` resolves, so two saves ~1s apart triggered two `updateModelState` passes, each seeing expired expiry and each firing its own concurrent `svn proplist -R -v .` (the most expensive command — recursive over the working copy). Observed 3× per multi-save burst. Added `_propertyRefreshInFlight` promise so concurrent callers share the same proplist.

---

## [0.2.35] - 2026-05-13

### Fixed

- **Staging perf**: optimistic stage/unstage bypassed `run()` (correct) but also skipped its grace-period side effect, so `svn changelist` `.svn/wc.db` writes triggered a reflex cascade (`svn info`, `svn stat`, `svn list`, second `svn stat`, `svn proplist -R -v .`) on every staged file. `stageOptimistic`/`unstageOptimistic` now call `setGracePeriod()` so the file watcher suppresses these — single staging now issues one `svn changelist` instead of six commands.

---

## [0.2.34] - 2026-05-07

### Refactored

- **Staging DRY**: collapsed `stageOptimistic` + `stageOptimisticWithChildren` into single `stageOptimistic(files, { expand })`
- **Staging UI churn**: `unstageOptimistic` now accepts grouped `Map<string|null, string[]>`; `unstageWithRestoreOptimistic` builds one map and dispatches one batched call instead of N (eliminates N×`updateActionButton` + N×`triggerInputValidation` per multi-changelist unstage)
- Extracted `notifyStagingChanged()` private — single point for action-button refresh + input-box revalidation (3 call sites → 1)

## [0.2.33] - 2026-04-15

### Fixed

- **Security**: `--password-from-stdin` was dead code for SVN ≥1.10 — missing else branch silently dropped passwords
- **Error logging**: Bare `catch {}` blocks in property cache now log errors instead of swallowing silently
- **Floating promise**: `saveAuth()` in retryRun now has explicit error handling
- **Type safety**: Removed `as any` cast in checkout depth picker

### Performance

- Pre-compiled error code regexes (avoid 22 RegExp allocations per error)
- Cached `semver.gte` version check (avoid per-spawn comparison)
- Cached 4 config reads in `updateModelState` hot path
- `refreshAllPropertyCaches` no longer blocks status update
- Added jitter to multi-repo poll timers (prevents simultaneous bursts)
- StatusService config cache filtered to relevant keys only
- Extracted shared `CredentialMode` type to `src/common/credentialMode.ts`

### Refactored

- Consolidated 9 command files into 4 (reveal, ignore, patch, commit)

## [0.2.32] - 2026-04-15

### Changed

- **Startup perf**: Merged duplicate `svn info` calls — pass parsed info from discovery to constructor (8→2 calls to first paint)
- **Startup perf**: Combined 3 separate `svn propget` calls into single `svn proplist -R -v .`
- **Startup perf**: Deferred proplist and remote check until after initial status renders
- **File-open perf**: In-flight dedup for `svn cat` — concurrent calls for same file+revision share one process
- **File-open perf**: Deduplicated `svn log` and `svn stat` calls on file open via debounce coalescing
- **File-open perf**: All property refreshes now use combined `svn proplist` instead of individual `svn propget` calls

### Fixed

- **Encoding**: Restored byte-sniff encoding detection for non-UTF-8 files not open in editor
- **TOCTOU race**: `pendingOpenPaths` guard now blocks before async `isSvnFolder` check
- **Cache correctness**: `cacheWarmed` flag prevents empty cache from being treated as valid during startup grace period

## [0.2.31] - 2026-04-14

### Changed

- **Needs-lock perf**: Expired cache now refreshes via single batch `svn propget -R` instead of spawning per-file propget calls
- **Pre-commit update perf**: Skip remote check for targeted updates — one fewer network round-trip
- **Pre-commit update perf**: Filter out unversioned/added files — skip update entirely when committing only new files
- **Pre-commit update reliability**: Remove fallback to full update — targeted failures surface cleanly instead of pulling unrelated changes

## [0.2.30] - 2026-04-11

### Changed

- **Commit workflow perf**: Pre-commit update targets only committed files (`svn update --parents <files>`), falls back to full update on benign failures
- **Commit workflow perf**: Pre-commit update runs in parallel with commit message input — user types while update downloads
- **Commit workflow reliability**: Auth/credential errors re-thrown instead of silently retried via fallback; cancellation properly detected in all code paths

## [0.2.29] - 2026-04-11

### Added

- **E2E integration tests**: 28 integration tests for real SVN operations (file lifecycle, changelists, branches, conflicts)
- **Test helpers**: `svnTestRepo.ts` for temp repo creation/teardown
- **Parser coverage**: Real SVN output for info, status, log, blame parsers
- **CI compatible**: All integration tests run on GitHub CI (Ubuntu, Windows, macOS)

### Fixed

- **Walkthrough accuracy**: All 14 walkthrough docs corrected — wrong command titles, non-existent settings, click vs right-click descriptions, `svn.` → `sven.` prefix

## [0.2.28] - 2026-04-07

### Added

- **Custom commit types**: New `sven.commit.types` setting — define your own commit types with icons and descriptions. No hardcoded types; empty by default. Type picker appears only when types are configured.

### Changed

- **Commit workflow perf**: Reuse cached remote-check result from background polling — skips redundant `svn log` network call when fresh
- **Commit workflow perf**: Parallel needs-lock checks — `Promise.all` instead of sequential `await` loop
- **Commit workflow perf**: Deduplicate post-commit history fetches — `updateRevision` called from `commitFiles` no longer fires its own `repolog.fetch`/`itemlog.refresh`
- **Commit workflow perf**: Parallelize history fetch + info refresh after commit with `Promise.all`
- **Commit workflow UX**: Post-commit update is now cancellable (kills SVN process via CancellationToken)
- **Status call perf**: `--show-updates` (network-hitting) now only added for remote checks and lock/unlock operations — file-watcher-triggered status refreshes stay local-only
- **Commit UX**: Quick-pick titles show message format preview at every step

### Removed

- **`sven.commit.conventionalCommits`** setting — behavior now derived from whether `sven.commit.types` is populated

### Fixed

- **`@types/vscode`**: Bumped to `~1.108.0` to match `engines.vscode ^1.108.0`

---

## [0.2.27] - 2026-03-26

### Added

- **Server-only commit color**: Commits above BASE in repo history now show in green (configurable via `sven.decorator.serverOnlyColor`) instead of being dimmed/invisible on dark backgrounds

---

## [0.2.26] - 2026-03-26

### Fixed

- **Cleanup error detection**: E155015 (conflict) no longer falsely triggers "Run Cleanup" — correctly routes to conflict resolution
- **Cleanup cache**: All cleanup operations now invalidate status cache — UI reflects actual state after cleanup
- **Error action buttons**: Explorer context menu errors now show full action button chain (cleanup, update, resolve, etc.) instead of plain error messages
- **Cleanup auto-retry**: Retries on E155004 (locked) in addition to E155037, and checks raw stderr for multi-code errors
- **Auto-retry error context**: Intermediate cleanup failure is logged and original error rethrown for clearer messaging
- **hasBlockedWord regex**: Was matching "locked" (false positives on lock errors) instead of "blocked" — one-char regex fix
- **Cleanup UI refresh**: Added `Operation.CleanUp` to `forceRefresh` list so UI actually refreshes after cleanup
- **Error sanitization**: Cleanup catch block now sanitizes error messages before display
- **Misclassified tokens**: Removed E155005 (WC not locked) and E155010 (path not found) from cleanup tokens
- **Format token drift**: `FORMAT_CLEANUP_TOKENS` now derived from `CLEANUP_ERROR_TOKENS` to prevent divergence
- **Cleanup retry**: Retry dialog is now properly awaited with max 3 retries before terminal fallback

## [0.2.25] - 2026-03-26

### Fixed

- **Selective download panel**: Use natural/numeric sort for directory and file names — `dos1, dos2, dos3, ..., dos10` instead of `dos1, dos10, dos2` ([#117](https://github.com/vrognas/sven/issues/117))

## [0.2.24] - 2026-03-04

### Fixed

- **Repo history readability**: Remove foreground color from server-only (S) commit decorations — `FileDecoration.color` was coloring entire label text, making commits above BASE unreadable on dark themes
- Remove `sven.decorator.serverColor` setting (no longer needed; S badge still appears without text color override)

## [0.2.23] - 2026-02-07

### Fixed

- Deflake Windows unit CI in legacy E2E suites by switching from `setup(...this.skip())` to per-test `testIfReady(...)` guards, preventing fixture access when suite preflight fails.

## [0.2.22] - 2026-02-07

### Fixed

- Deflake legacy E2E suites on Windows CI by replacing `suiteSetup`-only skip flow with `suiteReady` gating in `commands`, `repository`, `phase10`, and `svn` suites.
- Deflake `svnFinder` E2E assertions by skipping binary-dependent tests when `svn` is unavailable.
- Deflake `remoteChangeService` callback-error test by awaiting explicit second-poll signal with bounded timeout instead of fixed sleep.

## [0.2.21] - 2026-02-07

### Fixed

- Fix CI-only unhandled rejection in `phase10` suite by adding teardown settle delay before temp repo removal (`Failed to execute svn` from in-flight background status poll).

## [0.2.20] - 2026-02-07

### Fixed

- Fix Linux/macOS `svnAuthCache` cross-platform assertion flake by validating stable cache-dir suffix/absolute path instead of mocked-home prefix.

## [0.2.19] - 2026-02-07

### Fixed

- Fix cross-platform unit failures: use canonical SVN auth cache path (`auth/svn.simple`) and reject Windows-absolute path forms in `validateFilePath` on all platforms.
- Harden SCM input-box setup to tolerate proposal-gated properties in stable VS Code hosts.
- Stabilize VS Code harness activation with explicit binary/command preflight checks and actionable spawn failures.
- Stabilize path/auth/svn-finder suites and narrow `.vscode-test.mjs` to stable E2E targets.

## [0.2.18] - 2026-02-07

### Fixed

- Resolve TypeScript fail set in command, blame, security, and harness suites.
- Restore sinon stub compatibility for `child_process`/`fs.watch` mocking under Vitest.
- Make `npm test` cross-platform by replacing POSIX-only CI shell check with Node runtime check.

## [0.2.17] - 2026-02-07

### Added

- Expand blame fail-cluster tests (`blameProvider`) for lifecycle, event, mapping, and fallback branches.
- Expand security sanitizer tests (debug timeout flow + sanitized error log extraction).
- `src/blame/blameProvider.ts`: ~85% → ~96% lines.
- `src/security/errorSanitizer.ts`: ~37% → ~97% lines.
- Global `src/**` coverage increased to ~47-48% range.

## [0.2.16] - 2026-02-07

### Fixed

- Harden validation against decoded path traversal and encoded URL path metacharacters.
- Support root-stripped XML shapes in diff/list parsers.
- Correct changelist repository resolution when `null` repositories are returned.

### Changed

- Modernize legacy Vitest suites to ESM-safe mocking and current command/parser behavior.
- Stabilize cross-platform/path-sensitive tests (ResourceGroupManager, add/addRemove, prompt, auth cache, svnRepository).

## [0.2.15] - 2026-02-07

### Fixed

- Mock VS Code command registry now supports `thisArg` binding, matching real `registerCommand` behavior.
- `SwitchBranch` now accepts relative branch paths from branch picker; absolute URLs still validated.
- Base command resource selection now tolerates undefined entries instead of throwing.

### Added

- Modernize command e2e commit tests for staged/quick-commit flow.
- Add mock harness tests for config defaults, command binding, and `workspace.textDocuments` tracking.

## [0.2.14] - 2026-02-07

### Added

- Modernize legacy Mocha-style suites for Vitest (`vi.spyOn` over ESM export reassignment) in checkout/ignore/open command tests.
- Add Mocha-compat harness coverage (done callback, `this.timeout`, sync+async `this.skip`).
- Expand VS Code test mock for command registry and missing workspace/window/scm APIs used by legacy suites.

### Changed

- Increase unit test and hook timeout defaults for legacy suite parity (`60s`).

## [0.2.13] - 2026-02-07

### Changed

- Consolidate shared command helpers across stage/unstage/revert/changelist/pull/copy-path/commit/reveal/property/lock flows to reduce duplication.
- Extract reusable command error utilities for more consistent command execution and error handling.
- Add local agent and launch setup for contributor workflows.

### Fixed

- **Lock action ordering**: Prioritize explicit lock actions before cleanup fallback to avoid incorrect lock handling.
- **Lint script scope**: Restrict lint scripts to TypeScript paths to avoid hangs on bundled JavaScript output.

## [0.2.12] - 2025-02-05

### Fixed

- **SCM context menu**: "Diff with External Tool" now works from SCM Changes view
- **File History highlight**: Viewed revision now selected/highlighted when using "Open this revision"
- **Broken command links**: Fix all `command:svn.*` → `command:sven.*` in walkthroughs and welcome messages
- **Welcome messages**: File History pane now correctly describes auto-update behavior
- **Version alignment**: Align `@types/vscode` with `engines.vscode` (fixes CI packaging)

## [0.2.11] - 2025-02-04

### Changed

- Use standard markdown for development notice (Positron compatibility)

## [0.2.10] - 2025-02-04

### Changed

- Exclude `.vscodeignore` from VSIX package (reduces package size)
- Update README badges (CI status, marketplace downloads, license)
- Add active development notice to README

## [0.2.9] - 2025-02-04

### Added

- **Blame line mapping for modified files**: LCS-based line mapping — blame annotations now align with working copy content even when file is modified. Uses Longest Common Subsequence algorithm to map BASE line numbers to working copy.

### Changed

- **DRY**: Extract `mapBlameLineNumber()` helper (eliminates 4x duplicate code blocks)
- **DRY**: Move date formatting to shared `util/formatting.ts`
- **Performance**: Add LCS index structures for O(1) lookups (vs O(n) array.find)

## [0.2.8] - 2025-02-03

### Fixed

- **History filter for sparse commits**: Text search filters (author/message/path) now search entire history. Previously, `--limit` restricted commits _searched_, not results returned.
- **Blame cache staleness after external changes**: Blame cache now validates against VS Code document version. Cache invalidates automatically when document version changes.

## [0.2.7] - 2025-02-02

### Fixed

- **Theia IDE compatibility**: Bundle iconv-lite directly instead of dynamic require from VS Code's node_modules.

## [0.2.6] - 2025-02-02

### Changed

- **File watcher CPU optimization**: Increased throttle delay 100ms → 300ms (3x reduction in callback overhead). Skip file watcher during Update/SwitchBranch/Merge operations.

## [0.2.5] - 2025-01-29

### Fixed

- **Antigravity IDE compatibility**: Engine downgrade to vscode ^1.104.0.

## [0.2.4] - 2025-12-30

### Fixed

- **Config listener leak**: `authConfigDisposable` now cleaned up on deactivation
- **Cache cleanup**: Repository.dispose() clears needsLock/eol/mime/lock caches
- **Narrowed file watcher**: Changed from `**` to `**/.svn/{wc.db,entries}` for repo discovery
- **Deduplicated code**: Removed duplicate `getParentFolderStatus()` in decorator (-13 lines)

## [0.2.3] - 2025-12-26

### Changed

- **Property operations consolidation**: Auto-props and ignore patterns now use generic property methods. 11 property methods share core `getProperty/setProperty/deleteProperty`.

## [0.2.2] - 2025-12-26

### Changed

- **exec/execBuffer consolidation**: New private `executeProcess()` handles auth, spawning, timeout, cancellation. svn.ts reduced from 716 to 565 lines (-21%).

## [0.2.1] - 2025-12-26

### Changed

- **DRY command helpers**: New helpers in Command base (`filterResources()`, `toUris()`, `toPaths()`, `resourcesToPaths()`). Stage, Unstage, Revert, Commit commands use shared helpers.

## [0.2.0] - 2025-12-25

### Added

- **User-friendly command names**: SVN jargon mapped to plain language (EOL → "Line Ending", Blame → "Annotations", etc.)
- **Terminology glossary**: New command "SVN: Show Terminology Help..." with 12 searchable entries
- **Streamlined commit flow**: 2-step flow with file selection, step indicators, inline validation
- **Unified property management**: "SVN: Manage Properties..." consolidates 6+ commands
- **Design system docs**: `docs/DESIGN_SYSTEM.md` documents visual patterns, colors, badges
- **Actionable error buttons**: Auth, network, lock, cleanup errors now show contextual action buttons
- **Auto-onboarding**: First repo open shows "Quick Tour" prompt with walkthrough

### Changed

- **Less intrusive dialogs**: Commit message, resolve conflict, pre-commit conflicts use non-modal confirmations

## [0.1.9] - 2025-12-23

### Added

- **SVN property management**: Set/remove EOL style, MIME type, auto-props on files/folders
- **Context menu**: "Properties" submenu in Explorer and SCM views
- **Explorer tooltips**: Hover files to see eol-style and mime-type properties

## [0.1.8] - 2025-12-21

### Added

- **Needs-lock status bar**: Shows `$(unlock) N` when N files have svn:needs-lock property with click to manage
- **PM badge**: Files with both content and property changes show "PM" instead of "M"

## [0.1.7] - 2025-12-21

### Changed

- **Context menu harmonization**: Removed "with SVN"/"from SVN" suffixes, reorganized Explorer menu groups
- **Untracked vs deleted clarity**: "U" badge for untracked (file kept), "D" for deleted (file removed), strikethrough only for truly deleted

## [0.1.6] - 2025-12-21

### Added

- **Untrack command**: Renamed "Remove" → "Untrack" for clearer intent. Explorer context menu, folder support with confirmation, offer to add to svn:ignore after untracking.

## [0.1.5] - 2025-12-21

### Added

- **Watch files for remote changes**: Watch files/folders for remote change notifications. Status bar indicator, modal alerts, folder watch includes descendants, persistent across restarts.

## [0.1.4] - 2025-12-20

### Changed

- **Stat cache**: Cache stat() results for 1 minute with request deduplication. Cleared on repository changes (commit/update). Reduces redundant SVN commands.

## [0.1.3] - 2025-12-20

### Added

- **Beyond Compare auto-integration**: Set `sven.diff.tool` to `"beyondcompare"` for automatic CSV Table Compare. Auto-detects BC installation and generates wrapper script.

## [0.1.2] - 2025-12-20

### Fixed

- **Repository disposal on external files**: Opening files outside workspace (e.g., Beyond Compare configs) no longer causes SVN repo to disappear. Add `isDescendant` checks in BlameProvider.

## [0.1.1] - 2025-12-20

### Fixed

- **Double-activation errors**: Downgrade SvnFileSystemProvider registration errors to warnings. New command: `SVN: Clear SVN Path Cache`.

## [0.1.0] - 2025-12-18

### Changed

- **Rebrand to Sven**: Extension rebranded, new icon, command prefix `svn.*` → `sven.*`, settings prefix `svn.*` → `sven.*`

---

## Pre-Rebrand History

For changes prior to v0.1.0 (the rebrand from svn-scm to Sven), see [CHANGELOG_LEGACY.md](docs/archive/CHANGELOG_LEGACY.md).
