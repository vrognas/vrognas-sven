# Lessons Learned

**Version**: 0.2.98
**Updated**: 2026-07-13

---

### 90. An Exact Empty Result Is Not Algorithm Failure

**Lesson**: The sparse LCS returned `undefined` when two over-cap cores shared zero lines. That conflated a successfully proven empty LCS with resource exhaustion, disabled exact bracketing context, and made a one-line threshold crossing erase every blame mapping in a fully rewritten core.

**Fix**: Return `[]` for zero matches and reserve `undefined` for exceeded work/storage budgets. The existing bracketed rewrite synthesis can then reproduce dense attribution without allocating a quadratic matrix.

**Rule**: Result emptiness and computation failure are different states. Preserve that distinction through every fallback and test both sides of algorithm thresholds.

---

### 89. Cross-Working-Copy Invalidation Needs Operation Scope and Topology

**Lesson**: Treating every lexically nested SVN working copy as affected by a parent Update/Switch/NewBranch cleared independent nested repositories. A bare `Operation.Update` was also too coarse: full, ignored-external, targeted, pull-file, and sparse-depth updates touch different working-copy sets.

**Fix**: Keep unfiltered external-root metadata, carry normalized traversal/target impact in an additive post-operation event, union pre/post roots even on failure, and follow only declared external edges whose path exactly matches an opened WC root. Preserve the legacy operation event for unrelated consumers.

**Rule**: Cache invalidation follows actual dependency topology and operation targets, never directory ancestry or an overloaded enum alone.

---

### 88. Algorithm Thresholds Must Not Change Attribution

**Lesson**: A unique sparse LCS anchor is not necessarily safe: a moved unique line can cross a much longer repeated match and discard thousands of correct blame mappings. Likewise, choosing the first or last equal Hirschberg split does not reproduce dense backtracking; attribution can flip solely when the core crosses the dense-cell cap.

**Fix**: Before sparse fallback, discover low edit distance with a work-capped frontier and reconstruct the dense policy inside a bounded band. Above the direct trace-memory cap, retain rolling-row checkpoints and recompute one block at a time during traceback; do not discard an exact alignment merely because storing every direction would exceed memory. For bounded match graphs, recover the exact LCS with persistent prefix-maximum row snapshots, including repeated common lines and the dense equality-first/left-on-tie policy. Derive its pair limit from remaining node/work budgets, and use exact bracketing context to map internal rewrites linearly past the dense-gap cap while keeping one-sided deletions unmapped. Otherwise, when the total work budget is exhausted, retain a unique anchor only when no possible exact match crosses it. For linear-space LCS, propagate the midpoint column reached by the dense policy instead of resolving split ties locally.

**Rule**: Performance thresholds may change cost, never semantics. Align discovery and reconstruction budgets; never add a redundant fixed cap below the real resource limits. Use checkpointed traceback when full trace retention is the only exceeded resource. Differential-test every exact fallback against the reference algorithm, and treat “unique” as an anchor candidate—not proof that the anchor belongs in a maximum alignment.

---

### 87. Collapsing Per-Instance State Into a Singleton Silently Breaks Scoping

**Lesson**: Merging the per-repository `BlameProvider` into one shared singleton looked like a clean dedup, but every assumption that used to be true "because there's one instance per repo" quietly became false, and an adversarial review found four regressions the tests missed: (1) repo resolution switched from `isDescendant(workspaceRoot)` to `getRepository`, which _excludes_ svn:externals — so files under an external lost blame; (2) `messageCache` keyed by bare revision number collided across repos (r42 is a different commit in each); (3) `onRepositoryOperation` cleared _all_ caches, so a commit in repo A wiped repo B's blame; (4) lifecycle moved — the per-repo provider painted at repo-open and disposed at repo-close, but the singleton activates once at startup (before repos are discovered) and never releases per-repo hooks.

**Fix**: Resolve provider and status-bar blame via `getRepositoryFromUri` (pure descendant match, includes externals); scope `messageCache` by owning-repo `workspaceRoot`; scope invalidation to the operating repo's files; render on repo-open and release hooks on repo-close (tracked in a per-repo `Map`). Revalidate owner, document version, per-editor render generation, liveness, settings, active status-bar target, and status-refresh generation after every await. Coalesce active work per repo, run repos concurrently, and key edit/cursor timers by URI/editor. Capture the owner token in delayed edit cleanup. Fence deferred readiness callbacks by disposal state and cancel their pending debounces during teardown.

**Rule**: When collapsing N instances into one shared instance, enumerate everything implicitly scoped by that boundary: resolution, cache keys, invalidation, subscriptions, async applies, timers, and scheduling. Preserve the old concurrency partition: one slow repo must not block another, and target-specific cleanup/repaint must be lossless. Cache invalidation must follow exact dependencies, not a global or coarse scope. Test multiple repos and visible splits.

---

### 86. Trace the ACTUAL Serialization Layer Before "Relaxing" One

**Lesson**: A review flagged `@sequentialize` on `_doBlameFetch` as the thing serializing blame repo-wide, and recommended relaxing it to bounded concurrency. But every blame call goes through `Repository.blame` → `run()` → `retryRun()`, which awaits-and-replaces a per-repo `credentialLock` (it exists so concurrent auth-retries can't race on stored accounts and cause lockout). So the REAL serializer was the credential lock one level up; relaxing `@sequentialize` would have changed nothing. The genuine cost was that even in-memory cache HITS entered `run()` and queued behind a slow in-flight network op.

**Fix**: Lock-free `blameCached`/`getInfoCached` peeks that mirror the exact cache keys; `Repository.blame`/`getInfo` serve a hit directly and only enter `run()` on a miss. A BASE blame peek requires its memoized numeric revision; unresolved BASE misses and takes the full info-retry path. The credential lock stays intact for real fetches.

**Rule**: Before optimizing a serialization primitive, trace the call through every lock/queue. Keep true hits out of the locked path, but never approximate a normalized/resolved cache key to manufacture a hit; uncertainty is a miss.

---

### 85. A "Cleanup" Comment Can Encode a False Assumption — Verify Before Paying It Per-Render

**Lesson**: `applyIconDecorations` disposed and recreated every gutter-icon decoration type on _every_ render, justified by a comment: "16 types per file × 100 files = 1600 uncleaned types". But icon types key on the revision-age color palette — a bounded ~13-value set (5 categorical hues + 8 gradient buckets × theme), _shared across all files_, not per-file. The "leak" it guarded against couldn't happen; the dispose+recreate was pure churn on the hottest path (every editor switch), and it ran outside the render cache's hit guard.

**Fix**: Keep `iconTypes` alive across renders; on re-render clear only the colors this editor no longer uses and reuse the rest. Dispose only in `dispose()` and on config change (palette may change).

**Rule**: When a per-iteration teardown is justified by a scaling argument in a comment, check the argument's premise (here: is the keyspace really per-file, or bounded and shared?). A wrong premise turns a "leak fix" into a permanent hot-path tax. Cross-check what the cache key actually ranges over.

---

### 84. Stripping an LCS Diff's Common Prefix/Suffix Drops the Context Its Heuristics Need

**Lesson**: To bound an O(m·n) LCS line-mapping (freeze/OOM on large files), the obvious win is to strip the identical prefix/suffix and run the quadratic step only on the differing core. But the core algorithm told a _modified_ line apart from a _deleted_ one via context anchoring — "is there an LCS match before AND after this position?". Once the surrounding identical lines are stripped away, the core has no such matches, and every modified line in the core is misclassified as deleted (an existing "modified line still maps" test caught it).

**Fix**: Pass a `bracketBefore`/`bracketAfter` signal into the core: a stripped prefix/suffix _is_ a bracketing match, so `hasMatchBefore/After` must count it even though those lines are no longer in the core's own LCS. Above the dense-memory budget, use bounded Hirschberg LCS before sparse unique anchors; duplicate-heavy cores may have no unique anchors despite thousands of exact matches.

**Rule**: Before slicing an input to a heuristic that reasons about neighbouring context, ask what signal the removed region was carrying. Re-inject it as an explicit flag, and let the existing behavioural tests (not just the happy path) confirm the classification didn't shift.

---

### 83. A Global Epoch in a Cache Key Invalidates Everything on Any Change

**Lesson**: The blame render cache keyed on one global `messageEpoch`, so a message fetched for file A invalidated every file. Removing it entirely looked safe because message text is applied in Phase 2, but missed a hidden dependency: cached inline decorations still embed commit messages in their hover. A late message write could therefore leave a same-version cached hover stale forever.

**Fix**: Render entries record the exact repository scope and blamed revisions whose cached messages they embed. Writes and LRU evictions invalidate only matching entries; a transient scope epoch fences a message landing while an entry is being built.

**Rule**: Replace coarse invalidation with exact dependencies, not with no invalidation. Audit the whole cached object—including hover/tooltips—not just its visible text, and fence concurrent construction as well as later reuse.

---

### 82. Snapshot Before You Clear — and Keep Object Identity for In-Flight Guards

**Lesson**: `refresh()` cleared `logCache` and then looked the previous entry up in the same, now-empty map: `prev` was always `undefined`. Every debounced refresh silently dropped `isComplete`/`fullHistory`, the revision-changed staleness check was dead code, and rebuilding a NEW cache object tripped the object-identity guards of in-flight `fetchAll`/`goToRevision` on every unrelated file save.

**Rule**: If a rebuild consults prior state, snapshot (`new Map(cache)`) _before_ clearing. And when async consumers hold a reference and compare identity to detect invalidation, only replace the object when something actually invalidated it — otherwise mutate in place.

---

### 81. Completion State Must Come From a SUCCESSFUL Response

**Lesson**: `fetchMore` swallowed non-connection errors, leaving an empty page that flowed into the "fewer results than requested → history complete (+fullHistory)" heuristic. One transient auth failure/timeout silently truncated history: paging UI vanished, goToRevision reported real revisions as missing, filters answered locally from the partial window. Similarly `fetchNewer`'s bare `catch → 0` turned network failure into "you're up to date", and `fetchAll` looped forever on the one error class that _did_ return early.

**Rule**: Never derive completion/emptiness from a failed call — early-return (or flag) on ALL errors so the heuristic only sees real responses. Distinguish expected-error sentinels (E160006 "no such revision" = genuinely nothing newer) from failures before mapping an error to a benign value. And every retry loop needs an exit for the no-progress case.

---

### 80. svn Treats `scheme://` Targets as REPOSITORY URLs — Convert file-Uris at the CLI Boundary

**Lesson**: Blame's "Diff with Previous" passed the editor's `file://` document Uri into `svn log`; `toString()` made it a `file:///c:/ws/...` target, which svn resolves as a _repository_ URL (ra_local) — E170013 on every use. The unit test mocked `log()` entirely and even pinned the broken call shape, so 1900+ green tests never noticed a feature that failed 100% of the time against real svn.

**Fix**: One conversion at the `svnRepository` boundary (`uri.scheme === "file" ? uri.fsPath : uri.toString(true)`) for log/cat/diff, so every caller is safe.

**Rule**: Working-copy Uris become filesystem paths before reaching the svn CLI. And when a wrapper constructs CLI args, test the _args_ with the real method (mock only the process exec) — a fully-mocked wrapper test pins your assumptions, not svn's behavior.

---

### 79. `async` Can Be a Contract — De-async Only Where Tests Prove It's Noise

**Lesson**: A require-await cleanup de-asynced 20 warn-flagged methods. tsc stayed green, but 10 tests failed: `updateRemoteChangedFiles`'s `async` was the _contract_ — command callers `await` it and tests pin that a rejecting implementation propagates. Removing the `await` in callers silently orphaned the rejection. Two other asyncs were also load-bearing (the sequentialize decorator's wrapper converts sync throws into rejections so its `.then(run, run)` chain survives).

**Fix**: Reverted the contract-bearing trio with an inline disable stating _why_ the async stays; kept the 18 genuinely-noise removals. Test mocks in the untypechecked `test/` root also had to be synced by hand — tsc never saw them (the F17 gap).

**Rule**: `require-await` flags a _smell_, not a defect. Before de-asyncing: (1) do callers `.catch`/`await` it as an error channel? (2) does the `async` wrap sync throws into rejections on purpose? If yes, keep it and document with a targeted disable. And run the suite, not just tsc — Promise-shape changes are exactly what type-checking misses in untypechecked test roots.

---

### 78. Don't Return a Promise From a Constructor — Use a Static Factory

**Lesson**: `SvnRepository` and `SourceControlManager` ran async init by returning `(async () => { …; return this })() as unknown as T` from their constructors, gated by a `ConstructorPolicy` enum. `new X()` therefore lied about its type (a `Promise<X>` masquerading as `X`), every call site had to `await new X(...)`, and the sync-vs-async paths were entangled in one body.

**Fix**: A synchronous constructor that only initializes fields, plus a `static async create(...)` that constructs then awaits the async work. Production always used the eager path, so `ConstructorPolicy` was deleted; the test-only "late init" path is now a plain `new`.

**Rule**: A constructor must return an instance of its class, synchronously. Async setup belongs in a `static async create()` factory. `as unknown as T` on a constructor return is a red flag — the cast is hiding a Promise. This is also the entry point for dependency injection (see F31: the god-object `Repository` still news up VS-Code-bound collaborators inline).

---

### 77. Positional Clones of Wide Constructors Silently Drop Trailing Fields

**Lesson**: `Resource` has a 13-parameter positional constructor. A clone in `mergePreservedLockStatus` passed only 12 arguments, so the 13th (`propertyChanges`) defaulted to `undefined` — a file's pending property changes vanished whenever its lock status was re-applied. The compiler couldn't help: every trailing param is optional, so 12 args is valid.

**Fix**: A `withLock()` copy-helper that names the fields it overrides and forwards the rest, so adding a constructor param can never again be silently missed by a clone.

**Rule**: Never hand-clone an object by re-listing positional constructor args — one added field and every clone site silently loses it. Provide a copy-helper (or options-object constructor) that forwards all fields; wide positional constructors are a standing trap.

---

### 76. A Custom Error Class That Doesn't `extends Error` Fails `instanceof` Exactly When It Matters

**Lesson**: `SvnError` was a plain class with a `message` field, not an `Error` subclass. Every `error instanceof Error ? error.message : "Unknown error"` catch site therefore took the `else` branch for real SVN failures, so users saw "Unknown error" precisely when a genuine error had a real message to show. The bug hid because the type shape _looked_ like an error and structural `as ISvnErrorData` casts still worked.

**Fix**: `SvnError extends Error` (with `Object.setPrototypeOf(this, SvnError.prototype)` + `name`), an exported `isSvnError` guard, and a single svn-aware `getErrorMessage` that returns the _sanitized stderr_ (the informative content lives there, not in `.message` = "Failed to execute svn").

**Rule**: A throwable must `extends Error`, or `instanceof Error` checks across the codebase silently misfire. Add `setPrototypeOf` for transpiled targets, set `name`, and route all catch-site message extraction through one helper. For SVN, the useful text is in stderr — and stderr must be sanitized before display (URLs/paths/credentials).

---

### 75. Manifest Commands Can Outlive Their Handlers — Guard the Contract

**Lesson**: `sven.toggleWatch` / `sven.manageWatches` sat in `contributes.commands` and in two menus long after the watch feature was deleted. Nothing registered them, so the palette and context menu offered entries that threw `command not found`. Static review missed it because the manifest and the code drift independently — package.json declares, code registers, and no build step cross-checks the two.

**Fix**: Removed the orphaned declarations + menu refs, and added a unit test asserting every declared command appears as a registered string literal in non-test src, every menu/keybinding command is declared, and no id is duplicated.

**Rule**: A VS Code manifest is an untyped contract with the code. Any command id declared or referenced in package.json but never registered is a latent "command not found". Cross-check it in a test; the literal-string heuristic is enough and cheaply catches feature-removal leftovers.

---

### 74. Invalidate Between the Mutation and the Refresh — `finally` Runs Too Late

**Lesson**: `run()` cleared blame/info caches in `finally` — i.e. after the post-op `updateModelState` had already executed a forced `svn info` and seeded the info cache. The invalidation silently discarded data fresher than anything it was guarding against, forcing a redundant `svn info` on the next `getInfo`. The `finally` placement was chosen for a real reason (failed ops must also invalidate), but it conflated "always runs" with "runs at the right time".

**Fix**: Invalidation moved to immediately after the mutation resolves (before the model refresh) plus an explicit clear at the top of `catch` for the failure leg. Order-pinned by a test asserting `["clear", "status", "event"]`.

**Rule**: In do → invalidate → refresh pipelines, `finally` sequences the invalidation AFTER the refresh that repopulates. Place invalidation between mutation and refresh; cover the failure leg in `catch`, not by moving everything to `finally`. Pin the ordering with a test — placement bugs like this survive because "cache cleared: yes" assertions pass at any position.

---

### 73. Version History Is Immutable — an Explicit Refresh Can Prove Itself Redundant

**Lesson**: The repo-history panel's explicit refresh always cleared and refetched `svn log`, including right after `svn update`. But history at or below the working-copy revision cannot change; when the panel's newest cached entry already reached the post-update revision (typical: user watched incoming revisions arrive, then pressed Update), the refetch could only re-download identical data. The refresh conflated two different needs: "my entries may be stale" (refetch) and "my BASE marker moved" (re-render only).

**Fix**: At-newest skip in `refresh()`: on explicit refresh, if the previous cache's newest entry revision ≥ the current WC revision (and no load is in flight), keep entries and only move `persisted.baseRevision`. Post-commit still refetches — the new revision is above any cache.

**Rule**: Before forcing a refetch of monotonic/append-only data, compare the cache's high-water mark against the authoritative counter (SVN's revision number); refetch only below it. Keep display-state updates (markers, badges) decoupled from data refetches so skipping one doesn't skip the other.

---

### 72. A Skip-Guard Is a Cache — It Needs an Invalidation Story

**Lesson**: The status bar's same-line skip (`lastLineKey`) was keyed on `uri#line` but its outcome depended on inputs outside the key: blame data (changes on commit/update), `lineCount` (changes on edit), and transient error state. Three staleness bugs followed from one guard: pre-commit blame pinned while the cursor didn't move, a gated CSV that never recovered after shrinking below the limit, and a transient failure shown as "Not committed" forever. The sibling consumer (BlameProvider) got a repository-operation hook in the same series; the status bar didn't — a fix applied to one consumer but not its siblings just moves the bug.

**Fix**: Arm the skip only on the one definitive outcome (successful render), let every other path re-evaluate (they're cheap — config reads/cache hits, no subprocess), and reset it from the same `BLAME_INVALIDATING_OPERATIONS` hook the provider uses.

**Rule**: Any memo/skip/early-return keyed on X must enumerate the inputs NOT in X and either fold them into the key or reset on their change events. Default to arming such guards only on definitive success. And when adding an invalidation hook to one consumer of shared data, grep for its siblings — they have the same bug.

---

### 71. Hand-Mirrored Private Fields in Test Fakes Drift Into False Greens

**Lesson**: Three test files hand-rolled the same `Object.create(prototype)` fake of SvnRepository, each mirroring its private cache fields. One copy omitted `_blameGeneration`; `clearBlameCache()` then did `undefined++ → NaN`, `generation === this._blameGeneration` compared `undefined === NaN`, and every post-clear cache write was silently skipped — making a "post-clear blame must re-fetch" assertion pass for the wrong reason (exec count matched, cache state was wrong). The fixture exercised a constructor state that cannot exist in production.

**Fix**: One shared `makeFakeSvnRepo()` helper owning the full field set, with a comment naming the failure mode; assertions extended to check the positive post-condition (cache repopulated), not just call counts.

**Rule**: Prototype-swap fakes that mirror private fields must live in exactly one helper module per faked class. When a test asserts "X was cleared/re-fetched", also assert the state that should exist AFTER recovery — absence-only assertions pass equally well when the mechanism is broken.

---

### 70. A Setting Only Exists If Something Reads It

**Lesson**: `sven.blame.autoBlame` was defined in package.json, documented, written by the recommended-settings profiles ("Don't auto-blame — slow on large files") — and read by nothing. Blame auto-fetched on every file open regardless. Bonus divergence: package.json default was `true` while the code fallback said `false`, so even the intended default was ambiguous.

**Fix**: Wired `isAutoBlameEnabled()` into the per-file default in `BlameStateManager`; aligned the code fallback with the package.json default.

**Rule**: When adding a setting, grep for its accessor in the same PR — definition, docs, and profile writes don't make it real. Keep `get(key, fallback)` fallbacks byte-identical to the package.json default; mocks return the fallback, production returns the manifest default, and any divergence means tests validate behavior users never see.

---

### 69. Every Fetch Path Must Pass the Same Gates

**Lesson**: `BlameProvider.updateDecorations` gated blame behind CSV/large-file limits, but two sibling paths reached the same fetch without them: the status bar (own `repository.blame` on every cursor move) and the cursor handler (`updateInlineDecorationsForCursor`). Opening a 100k-line CSV showed "blame skipped" — then one click spawned the very `svn blame` the gate refused. Errors were also never cached, so a failing huge file re-spawned per debounced cursor pause.

**Fix**: Same size gates on all three entry paths; same-line skip before the debounced status-bar update; 30s negative cache for non-transient blame failures; blame cache check hoisted outside `@sequentialize` with in-flight dedup (getInfo/cat/list pattern); event-based `clearBlameCache()` on mutating ops with TTL as backstop.

**Rule**: A guard on one entry path is a bug on the others. When a fetch has multiple triggers (render, cursor, status bar, command), route them through one gated helper — and audit the set whenever a new trigger is added. Cache failures too: error paths that skip the cache write turn one doomed subprocess into one per UI event.

---

### 68. Build Expensive Error/Diagnostic Context Once, Pass It Down

**Lesson**: `handleOperationError` called `formatErrorMessage(error, ...)` followed by `getErrorContext(error)` on the next line. Both internally ran `sanitizeStderr` (13 sequential regex passes) and `.toLowerCase()` on the combined stderr. Same context built twice per error.

**Fix**: Extracted `formatErrorMessageFromContext(context, fallbackMsg)` so callers build the context once and reuse it. Public `formatErrorMessage(error, fallbackMsg)` kept as a thin wrapper so existing tests pass unchanged.

**Rule**: If a function is called for its side-information (context, parsed payload) and then the caller rebuilds the same thing for routing logic, extract a `*FromContext` variant. The wrapper preserves the simple call site for tests/external callers.

---

### 67. Hoist Config Reads and String Allocations Out of Per-Line Loops

**Lesson**: `BlameProvider` decoration loops read `blameConfiguration` accessors and built `rgba(127, 127, 127, X)` color strings _inside_ the per-line iteration. For a 1000-line file that was thousands of redundant `WorkspaceConfiguration.get` calls plus 1000 string allocations per render — all returning the same values.

**Fix**: Read each config flag once before the loop into a local; compute the color string once and reuse the reference inside `renderOptions.after.color`.

**Rule**: When a value is invariant across loop iterations, lift it. Per-line config reads and string concatenations look cheap individually but compound at scale on render hot paths.

---

### 66. Memoize Pure Transforms on Repeating-Input Hot Paths

**Lesson**: `formatBlameDate` was called once per line during gutter blame render. A 1000-line file with 50 unique commit dates ran 950 redundant `new Date(...)` + `toLocaleDateString(...)` round-trips, even though the input was identical across most calls.

**Fix**: Bounded cache keyed by `${format}|${dateStr}`. FIFO eviction at 1024 entries; 60s TTL so the "relative" form (which depends on `Date.now()`) doesn't visibly drift.

**Rule**: When a pure (deterministic-modulo-clock) transform is called in a tight loop with high input repetition, cache by input. Bound the cache and pick a TTL short enough that any time-dependent output stays fresh.

---

### 65. Reuse Stateless Parser/Regex Instances Across the Hot Path

**Lesson**: `XmlParserAdapter` constructed a fresh `XMLParser` with ~20 options on every SVN result, and `isTrunk` rebuilt its `RegExp` on every call from `HasBranch`. Both objects are stateless after construction — the per-call allocation was waste pinned to the hot path.

**Fix**: Lazy singleton for `XMLParser`; for `isTrunk`, cache the regex keyed by the config value pair so `vi.spyOn(configuration, "get")` test mocks still take effect cleanly.

**Rule**: If a parser/regex/compiled-pattern is stateless and configured from values that rarely change, cache the instance behind the configuration key — don't refuse to cache just because the config could theoretically change.

---

### 64. Tree Providers That Listen to Status Events Must Gate on Visibility

**Lesson**: `BranchChangesProvider` subscribed to `onDidChangeRepository` and refreshed on every status update — even when collapsed. Each refresh spawned 3+ SVN commands (`svn log --stop-on-copy`, `svn mergeinfo`, `svn info`, `svn diff --summarize`) per repo. Status events fire on every save/lock/refresh, so a hidden panel kept paying full network cost.

**Fix**: Switch `registerTreeDataProvider` → `createTreeView` (gains `.visible`), gate the change handler on `treeView.visible`, and fire one refresh on `onDidChangeVisibility` to update stale data when the user re-opens the panel. Same pattern already used in `ItemLogProvider` (v0.2.52) and `RepoLogProvider`.

**Rule**: Any tree provider that consumes `onDidChangeRepository` (or similar high-frequency events) and does _anything_ expensive in `getChildren` must skip refreshes while hidden, and must refresh once on visibility transition.

---

### 63. Dead Code Can Hide Security Features

**Lesson**: `passwordForStdin` in svn.ts was declared, checked, and consumed — but never assigned. The `--password-from-stdin` path for SVN ≥1.10 was completely inert since the auth cache refactor. The if/else chain fell through silently.

**Fix**: Add the missing `else` branch. Also add tests that verify stdin is actually written to.

**Rule**: When refactoring branching logic, test every branch outcome explicitly — not just the new path, but that existing paths still fire.

---

### 62. Network Flags Should Be Opt-In, Not Always-On

**Lesson**: `fetchLockStatus = true` was hardcoded in `run()`, adding `--show-updates` (network call) to every status refresh — including file-watcher-triggered ones. This caused 20+ server round-trips during normal usage like opening files.

**Fix**: Extract `shouldFetchLockStatus(operation)` — returns `true` only for `StatusRemote`, `Lock`, `Unlock`. Regular status stays local-only.

**Rule**: Flags that hit the network must be opt-in per operation, never hardcoded to always-on.

---

### 61. Reuse Background Polling Results for User-Triggered Checks

**Lesson**: Pre-commit update called `svn log -r BASE:HEAD` even though background polling already checked seconds ago. On slow connections, this added 5-30s of pure wait.

**Fix**: Cache `hasRemoteChanges` result with timestamp. `PreCommitUpdateService` reuses it if within poll interval. Both `hasRemoteChanges()` and `updateModelState(checkRemote=true)` populate the cache.

**Rule**: When background polling already computes a value, cache it with TTL and let on-demand paths reuse it.

---

### 60. Deduplicate Cascading Refreshes in Compound Operations

**Lesson**: `commitFiles()` called `updateRevision()` post-commit, which fired `repolog.fetch` + `itemlog.refresh`. Then `commitFiles()` fired the same two commands again. 4 redundant history fetches per commit.

**Fix**: Add `skipHistoryRefresh` option to `updateRevision()`. Caller handles refresh once.

**Rule**: When operation A calls operation B, let A own the side effects — give B an opt-out flag.

---

### 58. Always Invalidate Cache After Cleanup

**Lesson**: `cleanup()` didn't call `resetInfoCache()`, only `removeUnversioned()`/`removeIgnored()` did. After lock repair (most common cleanup), UI showed stale "locked" status.

**Fix**: Call `resetInfoCache()` unconditionally after all cleanup variants.

**Rule**: Cache invalidation should match operation scope, not just the "destructive" subset.

---

### 59. Unify Error Handling Across Command Paths

**Lesson**: `executeOnResources` only offered "Run Cleanup" button. `executeOnUrisOrResources` (Explorer) offered no action buttons at all. `handleRepositoryOperation` had the full priority chain. Three paths, three behaviors.

**Fix**: Extract `handleOperationError()` with full priority chain (auth > lock > cleanup > update > conflict > output). All paths delegate to it.

**Rule**: Error handling is a crosscutting concern — extract once, reuse everywhere.

---

### 56. Legacy E2E Preflight: Use Suite-Ready Guard, Not suiteSetup Skip

**Lesson**: In mixed Mocha/Vitest harnesses, `this.skip()` inside `suiteSetup` can still leave tests running with uninitialized fixtures on some runners.

**Fix**:

- Add `suiteReady = false` by default.
- Wrap each test with `testIfReady(...)` and run `this.skip()` inside the test context when not ready.
- Set `suiteReady = true` only after full preflight/setup success.

**Rule**: For binary/extension preflight in legacy E2E suites, guard each test via readiness flag; do not rely on `suiteSetup` skip alone.

---

### 55. Polling Tests: Await Explicit Signal, Not Fixed Sleep

**Lesson**: Fixed short sleeps (`setTimeout(120)`) in timer tests can flake under CI load and miss expected callback counts.

**Fix**:

- Resolve a promise on the target callback invocation.
- Await that promise with a bounded timeout.

**Rule**: For timer/poll assertions, wait on explicit condition/event + timeout; avoid fixed-sleep count checks.

---

### 54. Background Polls: Teardown Must Wait Before Repo Deletion

**Lesson**: Tests can pass yet CI still fail when Vitest sees unhandled rejections from in-flight background SVN polls during teardown.

**Fix**:

- Dispose repositories first.
- Wait briefly for in-flight poll/status promises to settle.
- Remove temp repos after the settle delay.

**Rule**: In suites with polling/watchers, cleanup order is dispose → settle → delete temp resources.

---

### 53. Cross-Platform Unit Tests: Avoid Mocked-Home Prefix Assumptions

**Lesson**: `os.homedir` monkey-patching may not reliably drive imported module behavior across all runners; prefix assertions can become CI-only flakes.

**Fix**:

- For cache-dir assertions, validate invariant suffix (`.subversion/auth/svn.simple`) + absolute path.
- Avoid strict `startsWith(testCacheDir)` checks for default-home constructors.

**Rule**: In platform tests, assert stable invariants; avoid runner-dependent home-path assumptions.

---

### 52. Cross-Platform Paths/Auth: Match Real SVN + Windows Rules

**Lesson**: CI portability breaks when tests/runtime assume extension-specific auth paths or platform-local absolute-path semantics.

**Fix**:

- Use canonical SVN auth cache dir: `auth/svn.simple` (not `sven.simple`).
- Reject Windows-absolute path forms on all platforms (`C:\...`, `\\server\share`, `\Windows\...`).
- In integration suites, skip early when required binaries/commands are unavailable.

**Rule**: Path/auth logic must be platform-invariant unless behavior is explicitly OS-specific.

---

### 51. Vitest+Sinon Stubs: Keep CommonJS Boundary for Stub Targets

**Lesson**: For modules stubbing built-in APIs (`child_process.spawn`, `fs.watch`) with sinon, ESM import shape can break stubs.

**Fix**:

- Keep local CommonJS require binding for stubbed module targets in runtime/tests.
- Use local lint suppression only on those boundary lines.

**Rule**: Prefer ESM generally, but keep require-boundary where sinon stub target identity must stay mutable.

---

### 50. Coverage Fail-Cluster: Hit Biggest Bucket First

**Lesson**: Coverage climbs faster when pass starts with highest uncovered-line file, not easiest file.

**Applied**:

- Pass 1: `src/blame/blameProvider.ts` (largest uncovered in blame/security/auth cluster)
- Pass 2: `src/security/errorSanitizer.ts`

**Result**:

- `blameProvider` line coverage moved to high-90s.
- `errorSanitizer` line coverage moved to high-90s.

**Rule**: For aggressive coverage goals, rank uncovered lines first, then test in descending bucket order.

---

### 32. Vitest Migration: Avoid ESM Export Reassignment

**Lesson**: Legacy Mocha tests that assign imported module exports break under ESM.

**Issue**:

- Patterns like `(module as any).fn = ...` fail with readonly namespace exports
- Typical error: `Cannot set property ... which has only a getter`

**Fix**:

- Replace export reassignment with `vi.spyOn(module, "fn").mockImplementation(...)`
- For heavy per-test override patterns, route through one mutable local implementation function

**Rule**: In Vitest+ESM suites, mock with spies, never write to imported module exports.

---

### 33. VS Code Mock Fidelity: Bindings + Defaults Matter

**Lesson**: Legacy suite stability depends on mock parity with VS Code APIs.

**Issue**:

- Command callbacks registered with `thisArg` broke when mock ignored binding.
- Config reads without explicit default returned `undefined` in mock, unlike extension defaults.
- Missing `workspace.textDocuments` tracking broke runtime code paths that inspect open docs.

**Fix**:

- Implement `registerCommand/registerTextEditorCommand` with `thisArg` application.
- Add persisted mock config store with key defaults for common `sven.*` settings.
- Track opened documents in mock workspace (`openTextDocument` + `textDocuments`).

**Rule**: When modernizing harness, prioritize runtime API parity over minimal stubs.

---

### 34. XML Adapter Contract: Root Can Be Stripped

**Lesson**: Parsers using shared XML adapter must accept root-stripped and rooted shapes.

**Issue**:

- `parseXml()` uses `explicitRoot: false` by default.
- Legacy parser transforms expected only rooted forms (`paths.path`, `list.entry`).
- Result: diff/list parser regressions on valid SVN XML.

**Fix**:

- In parser transforms, accept both forms (`result.paths?.path ?? result.path`, `result.lists?.list ?? result.list ?? { entry: result.entry }`).

**Rule**: When adapter defaults change, parser tests must include both rooted and root-stripped fixtures.

---

## Core Patterns

### 0. Path Guards Before SVN Operations

**Lesson**: Always check if file is inside repository before running SVN commands.

**Bug** (v0.1.2):

- Opening external files (outside workspace) caused repo to disappear
- BlameProvider called `repository.getInfo()` on external file
- SVN returned "NotASvnRepository" error
- Error handler set `RepositoryState.Disposed` → repo gone

**Fix**: Add `isDescendant(workspaceRoot, file.fsPath)` guard before any SVN operation.

**Rule**: Guard all SVN operations with path membership check first.

---

### 1. Build System: tsc over webpack

**Lesson**: Direct TypeScript compilation provides better type safety and debugging than bundling.

**Benefits**:

- Full strict mode enforcement (found 21 hidden bugs)
- Individual modules easier to debug
- 20% faster builds

**Trade-offs**:

- Larger package size (+250KB acceptable)
- Runtime dependencies must be in `dependencies` not `devDependencies`
- `.vscodeignore` must include all compiled modules

**Rule**: Use tsc for extensions unless bundling truly needed.

---

### 2. Service Extraction Pattern

**Lesson**: Extract stateless services from god classes incrementally.

**Approach**:

1. Write 3 TDD tests first (core scenarios)
2. Create stateless service with parameter objects
3. Extract verbatim (preserve behavior)
4. Move decorators to caller
5. Refactor incrementally after tests pass

**Results** (Phase 2):

- 760 lines extracted (StatusService, ResourceGroupManager, RemoteChangeService)
- Repository.ts: 1,179 → 923 lines (22% reduction)
- Zero breaking changes

**Rule**: Multiple small extractions beat one big refactor.

---

### 3. Dependency Migration: Adapter Pattern

**Lesson**: Abstract old API behind compatibility layer when migrating dependencies.

**Pattern** (xml2js → fast-xml-parser):

1. Create adapter abstracting parser API
2. Add compatibility tests before migration
3. Migrate simplest parser first
4. Validate pattern, then migrate complex parsers

**Results**:

- 79% bundle reduction (45KB → 9.55KB)
- Zero functionality changes
- Can swap parser again in future

**Critical Fix** (v2.17.137):

- Bug: Revision expansion failed - `textNodeName` was `#text` not `_`
- Root cause: fast-xml-parser uses different defaults than xml2js
- xml2js: text nodes → `_` (when mergeAttrs: true)
- fast-xml-parser: text nodes → configurable via `textNodeName`
- Fix: Set `textNodeName: "_"` to match xml2js behavior
- Test gap: No test verified `_` property, only attributes

**Rule**: De-risk migrations with adapters + incremental rollout.
**Rule**: Test text content extraction, not just attributes.

---

### 4. Type Safety: No Bypasses

**Lesson**: transpileOnly and `any` types hide bugs. Fix types, don't disable checker.

**Found**:

- 21 TypeScript errors masked by webpack transpileOnly
- 248 `any` types across 25 files compromise safety

**Impact**:

- 10× unknown error types
- 4× null/undefined checks missing
- Array/readonly violations

**Rule**: Enable strict mode from start. No `any` without explicit justification.

---

### 5. Performance: Measure User Impact

**Lesson**: Prioritize optimizations by end-user impact, not code elegance.

**High-impact fixes** (Phases 8-16):

- Debounce/throttle: 60-80% burst reduction
- Config cache: 100% users, -10ms per command
- Conditional index rebuild: 50-80% users, 5-15ms saved
- Decorator removal: 1-2ms → <0.5ms

**Low-ROI efforts**:

- God class refactoring: 6-8h effort, minimal user benefit
- Over-optimization: Diminishing returns after P0/P1 fixes

**Rule**: Profile real usage. Fix P0 bottlenecks before refactoring.

---

### 6. Error Handling: Descriptive Messages

**Lesson**: Silent error handling is debugging nightmare.

**Anti-pattern**:

```typescript
if (err) {
  reject();
} // ❌ No error message
```

**Best practice**:

```typescript
catch (err) {
  console.error("parseInfoXml error:", err);
  reject(new Error(`Failed to parse: ${err.message}`));
}
```

**Impact**: Previous migration failures debuggable only after adding logging.

**Rule**: Always include context in error messages.

---

### 7. Testing: TDD + 3 End-to-End Tests

**Lesson**: Write tests before implementation. 3 core scenarios sufficient per feature.

**Coverage progress**:

- 138 → 844 → 930+ tests (+792, +574%)
- 21-23% → 50-55% → 60-65% coverage ✅ EXCEEDED TARGET
- Phase 22 (v2.17.235): +41 e2e tests covering critical gaps

**Pattern**:

1. 3 end-to-end tests (happy path + 2 edge cases)
2. Unit tests for critical logic only
3. Don't overtest implementation details
4. Real SVN/file system for e2e (no mocks)

**Coverage additions** (v2.17.235):

- Core layer: svn.ts (3), svnFinder (3), resource.ts (3)
- Services: StatusService (3), ResourceGroupManager (3), RemoteChangeService (3)
- Commands: add (3), remove (3), commitAll (3), upgrade (3), pullIncomingChange (3)
- File system: mkdir (2), write_file (2), read_file (2), stat (2)

**Rule**: Test behavior, not implementation. Stop at 50-60% coverage.

---

### 8. Incremental Commits

**Lesson**: Small focused commits enable easy review, revert, cherry-pick.

**Examples**:

- Phase 1: 13 commits (10 lines avg)
- Phase 2: 1 commit per service extraction
- XML migration: 9 commits (one per parser)

**Benefits**:

- Clear version history
- Bisectable (find regressions fast)
- Low review overhead

**Rule**: Version bump per commit. One concern per commit.

---

### 9. Critical Path Mapping

**Lesson**: Map failure cascades before refactoring critical code.

**Found**: Extension activation depends on `parseInfoXml()` in 2 places:

- `source_control_manager.ts:295` - workspace scan
- `svnRepository.ts:86` - repository init

**Risk**: Parse failure = silent repository failure (no error shown to user).

**Mitigation**: Test critical paths extensively. Add diagnostic logging.

**Rule**: Know where failures cascade before touching critical code.

---

### 10. Code Review: Type Safety Checks

**Lesson**: Code review catches gaps missed during extraction.

**Blockers found** (Phase 2):

1. Unsafe cast: `groups as any as ResourceGroup[]`
2. Encapsulation leak: Exposed internal `_groups` Map
3. Incomplete interfaces: Missing config types

**Rule**: Review for type safety, encapsulation, performance after extraction.

---

### 11. Batch Operations: Trade Bandwidth for Latency

**Lesson**: Fetching extra data is faster than multiple network calls.

**Example** (v2.17.210 - Batch SVN log):

- Before: 50 sequential `svn log -r REV:REV` commands = 5-10s
- After: 1 command `svn log -r MIN:MAX` = 0.1-0.2s
- Trade-off: 2x bandwidth for 50x speed

**Pattern**:

1. Find min/max range of requested items
2. Fetch entire range in single call
3. Filter results to requested items
4. Cache all fetched data for future use

**When to use**:

- ✅ High latency operations (network calls)
- ✅ Cheap filtering on client side
- ✅ Sparse data across small range
- ❌ Huge ranges (>1000x requested items)

**Rule**: For N network calls, consider single batch + filter if latency >> bandwidth.

---

### 17. Cache Eviction: LRU Policy

**Lesson**: Unbounded caches cause memory leaks; use LRU eviction to cap growth.

**Example** (v2.17.215 - Blame cache):

- Before: Unlimited blameCache + messageCache = 700KB+ per 100 files
- After: MAX_CACHE_SIZE=20, MAX_MESSAGE_CACHE_SIZE=500 = bounded memory
- Implementation: cacheAccessOrder Map tracks access time, evictOldestCache()

**Pattern**:

1. Add Map<key, timestamp> to track access order
2. Update timestamp on cache hit/miss
3. Evict oldest entry when size exceeds limit
4. For immutable caches, simple FIFO eviction works (batch 25%)

**When to use**:

- ✅ Long-running sessions (editors, servers)
- ✅ Large cache entries (>1KB per item)
- ✅ Unpredictable access patterns
- ❌ Short-lived processes (startup scripts)

**Rule**: Cache without eviction = eventual memory leak. Set explicit limits.

---

### 12. VS Code Dynamic Icons: No Static Icon in Command

**Lesson**: For context-based dynamic icons, remove icon from command definition.

**Issue**: Static icon in command definition overrides dynamic menu icons.

**Example** (v2.17.222 - Blame toggle icon):

- Before: `"command": "svn.blame.toggleBlame", "icon": "$(eye)"` (static)
- After: Removed icon from command, only in menu contributions with `when` clauses
- Result: Icon changes based on context (eye → eye-closed → circle-slash)

**Pattern**:

1. Command definition: NO icon property
2. Menu contributions: Multiple entries with same command, different when clauses
3. Each menu entry has different icon based on context variables

**Anti-pattern**:

```json
"commands": [
  {"command": "foo", "icon": "$(eye)"}  // ❌ Overrides dynamic icons
]
```

**Best practice**:

```json
"menus": {
  "editor/title": [
    {"command": "foo", "when": "ctx == true", "icon": "$(eye)"},
    {"command": "foo", "when": "ctx == false", "icon": "$(eye-closed)"}
  ]
}
```

**Rule**: Dynamic icons require context-based menu entries, no command icon.

---

### 13. Remote Development: extensionKind Required

**Lesson**: SCM extensions must declare `extensionKind: ["workspace"]` for remote development.

**Issue** (v2.17.237):

- Extension activated on both local and remote in SSH sessions
- Caused "command already exists" error, breaking all functionality
- Silent failure: no error shown to user

**Fix**:

```json
"extensionKind": ["workspace"]
```

**Why**:

- SCM extensions need access to file system and CLI on remote
- `workspace` = run only on remote, not local
- Prevents duplicate command registration

**Rule**: Always add `extensionKind: ["workspace"]` for extensions needing remote file/CLI access.

---

### 14. Error Detection: Check Specific Patterns First

**Lesson**: When detecting error types, check specific patterns before generic ones.

**Issue** (v2.17.238):

- SVN returns E170013 (network) with E215004 (no credentials) on auth failure
- `getSvnErrorCode()` loop found E170013 first, returned "network error"
- Auth retry logic never triggered because error wasn't detected as auth error
- Users saw "Network error" when issue was actually missing credentials

**Fix**:

```typescript
// BEFORE: Generic loop finds E170013 first
for (const code of errorCodes) {
  if (stderr.includes(code)) return code; // E170013 wins
}
if (stderr.includes("No more credentials")) return "E170001"; // Never reached!

// AFTER: Check specific patterns FIRST
if (stderr.includes("E215004") || stderr.includes("No more credentials")) {
  return "E170001"; // Auth error takes priority
}
for (const code of errorCodes) { ... } // Generic codes
```

**Why**:

- SVN errors can have multiple codes in same stderr output
- Generic patterns (E170013) may mask specific ones (E215004)
- User action depends on correct error classification

**Rule**: Order error checks by specificity - specific patterns before generic ones.

---

### 15. Remote SSH: Respect Native Credential Stores

**Lesson**: Don't disable system credential managers (gpg-agent, gnome-keyring) in remote environments.

**Issue** (v2.18.0):

- Extension always passed `--config-option config:auth:password-stores=` to SVN
- This disabled gpg-agent/gnome-keyring, breaking remote SSH workflows
- Password prompt cycled endlessly because:
  1. Extension credential cache needs `realmUrl` from `svn info`
  2. But `svn info` itself needs auth → chicken-egg problem
  3. Without cached credentials, SVN rejected `--password` on command line
  4. Auth failed, prompted again → infinite loop

**Fix** (v2.26.0 - simplified):

```typescript
// Use credentialMode setting with auto-detection
const mode = configuration.get("auth.credentialMode", "auto");
const isRemote = !!env.remoteName;
const useSystemKeyring =
  mode === "systemKeyring" || (mode === "auto" && !isRemote);

if (!useSystemKeyring) {
  args.push("--config-option", "config:auth:password-stores=");
  args.push("--config-option", "servers:global:store-auth-creds=no");
}
```

**Why auto mode works**:

- Detects local vs remote (SSH/WSL/container) automatically
- Local: Uses system keyring (gpg-agent, Keychain, Credential Manager)
- Remote: Uses VS Code SecretStorage (no keyring setup needed)

**Security** (v2.26.0):

- SVN 1.10+ uses `--password-from-stdin` (hides from process list)
- SVN < 1.10: Password NOT passed - must use system keyring
- Removed insecure `--password` command-line fallback

**Rule**: Default to `auto` mode - it handles most scenarios correctly.

---

## Quick Reference

**Starting extension**: tsc + strict mode + Positron template
**Migrating deps**: Adapter pattern + TDD + incremental
**Extracting services**: Stateless + parameter objects + decorators at caller
**Optimizing**: Profile user impact, fix P0 first
**Testing**: 3 E2E tests per feature, 50-60% coverage target
**Committing**: Small focused commits, version bump each

---

## Anti-Patterns to Avoid

❌ transpileOnly (bypasses type checking)
❌ Silent error handling (no context)
❌ Big bang refactors (high risk)
❌ Premature optimization (fix bottlenecks first)
❌ Over-testing (diminishing returns >60%)
❌ God commits (hard to review/revert)

---

### 16. Testing: Vitest for Unit Tests

**Lesson**: Use Vitest for unit tests, keep Mocha for VS Code E2E tests.

**Migration** (v2.23.0):

- Unit tests: Vitest (104 tests, runs in 1.5s)
- E2E tests: Mocha + @vscode/test-electron (needs VS Code API)
- Dual framework: Both run in parallel in CI

**Benefits**:

- 6-10x faster unit tests (no TypeScript compilation needed)
- Better error messages with object diffs
- Watch mode for development
- Built-in coverage (replaces c8)

**Pattern**:

```typescript
// Vitest (unit tests)
import { describe, it, expect, vi } from "vitest";
describe("Parser", () => {
  it("parses XML", () => {
    expect(result).toHaveLength(1);
  });
});

// Mocha (E2E tests needing VS Code)
suite("Extension", () => {
  test("activates", async () => {
    const ext = vscode.extensions.getExtension("...");
  });
});
```

**Key insight**: Mock `vscode` module via `vitest.config.ts` alias for unit tests.

**Rule**: Use Vitest for pure logic, Mocha only when VS Code API required.

---

### 18. SVN Locking for Large Files

**Lesson**: SVN's lock-modify-unlock workflow mitigates "poor SVN usage" in data science repos.

**Problem domains**:

- Monolithic checkouts (sparse checkout needed)
- Binary bloat (large CSVs, models, datasets)
- Locking ambiguity (unclear who has lock)
- Disconnected history (vague commit messages)

**Implementation** (v2.24.0):

- Commands: `lock`, `unlock`, `breakLock`
- Lock info in tooltips (🔒 Locked by <user>)
- Explorer context menu integration
- Directory locking support

**Pattern**:

```typescript
// Lock with optional comment
await repository.lock(files, { comment: "Editing dataset" });

// Break lock owned by another user
await repository.unlock(files, { force: true });

// Check lock status
const lockInfo = await repository.getLockInfo(filePath);
if (lockInfo) console.log(`Locked by ${lockInfo.owner}`);
```

**Rule**: Lock files before editing large binaries. Use lock comments for coordination.

---

### 19. CLI vs GUI Feature Parity

**Lesson**: Not all GUI options map to CLI flags. Research before implementing.

**Example** (v2.30.0 - Cleanup):

- TortoiseSVN has "Break locks" checkbox (calls C API directly)
- SVN CLI always breaks locks (hardcoded in `svn_client_cleanup2()`)
- No `--break-locks` flag exists - it's always on

**Pattern**:

1. Check SVN CLI `--help` for actual flags
2. Check if feature is hardcoded in CLI source
3. For GUI-only features, document limitation
4. Don't create "phantom" options that do nothing

**Reference**: [TortoiseSVN Cleanup](https://tortoisesvn.net/docs/release/TortoiseSVN_en/tsvn-dug-cleanup.html)

**Rule**: When porting from GUI to extension, verify CLI supports the feature.

---

### 20. Cleanup Error Detection: Multiple Codes

**Lesson**: SVN cleanup is needed for multiple error types, not just E155004.

**Error codes requiring cleanup** (v2.31.0):

- **E155004**: Working copy is locked
- **E155037**: Previous operation interrupted
- **E200030**: SQLite database busy/locked/corrupt
- **E155032**: Working copy database problem

**Text patterns**:

- "locked", "previous operation", "run 'cleanup'", "sqlite"

**E155015 (conflict) does NOT need cleanup**:

- Conflicts require `svn resolve`, not cleanup
- "Obstructed" status often needs delete + update, not cleanup

**UX Pattern**:

```typescript
if (needsCleanup(error)) {
  const choice = await window.showErrorMessage(msg, "Run Cleanup");
  if (choice === "Run Cleanup") {
    await commands.executeCommand("svn.cleanup");
  }
}
```

**Rule**: Offer actionable buttons for recoverable errors.

---

### 21. User-Friendly Errors: Show Code for Transparency

**Lesson**: Include error codes in user messages for transparency and googlability.

**Pattern** (v2.32.0):

```
"Working copy locked (E155004). Run cleanup to fix."
```

**Benefits**:

- User can Google the error code for more details
- Technical users get context they need
- Non-technical users get actionable guidance

**Implementation**:

```typescript
// Extract code, format message
const code = extractErrorCode(stderr); // E155004
return `Working copy locked (${code}). Run cleanup to fix.`;
```

**Action Buttons**: Match error type to action:

- Cleanup errors → "Run Cleanup" button
- Out-of-date → "Update" button
- Conflicts → "Resolve Conflicts" button

**Rule**: Always include error code in parentheses. Offer one actionable button per error type.

---

### 22. Timer Disposal: Store References

**Lesson**: Always store timer references and clear them in dispose().

**Issue** (v2.32.12):

- `setInterval()` and `setTimeout()` not cleared on extension reload
- Timers accumulate over reloads, causing memory leaks
- Especially problematic during development with frequent reloads

**Pattern**:

```typescript
// BAD: Timer created but never cleared
setInterval(() => this.cleanup(), FIVE_MINUTES);

// GOOD: Store reference, clear in dispose
private cleanupInterval?: ReturnType<typeof setInterval>;

constructor() {
  this.cleanupInterval = setInterval(() => this.cleanup(), FIVE_MINUTES);
}

dispose(): void {
  if (this.cleanupInterval) {
    clearInterval(this.cleanupInterval);
  }
}
```

**Rule**: Every `setInterval`/`setTimeout` needs corresponding `clearInterval`/`clearTimeout` in dispose().

---

**Document Version**: 0.2.8
**Last Updated**: 2025-02-03

### 23. VS Code TreeView Providers: Listen for Repository Open/Close Events

**Lesson**: TreeDataProviders created during extension activation may miss initial data if async initialization isn't complete.

**Issue** (v2.32.17):

- Repository Log and Selective Download treeviews displayed empty at startup
- Required manual refresh to show data
- Root cause: SourceControlManager scans workspace folders asynchronously (fire-and-forget)
- Providers created AFTER SourceControlManager constructor but BEFORE repositories discovered
- `sourceControlManager.repositories` was empty when providers called `getChildren()`

**Fix**:

```typescript
// In constructor, subscribe to lifecycle events
this._disposables.push(
  this.sourceControlManager.onDidOpenRepository(() => {
    this.refresh();
  }),
  this.sourceControlManager.onDidCloseRepository(() => {
    this.refresh();
  })
);
```

**Why this pattern is needed**:

- VS Code extensions often use async initialization for performance (non-blocking activation)
- TreeDataProviders may be created before data is available
- `onDidOpenRepository` fires when async discovery completes
- Without listening to this event, providers never know data is ready

**When to apply**:

- ✅ TreeDataProvider depends on async-discovered resources (repos, files, configs)
- ✅ Provider created during `activate()` before async init completes
- ✅ Data source fires lifecycle events (open, close, change)
- ❌ Static data available immediately at construction time

**Rule**: TreeDataProviders must subscribe to data source lifecycle events, not just change events.

---

### 24. SVN Peg Revision: Pass Separately, Don't Embed in Path

**Lesson**: Never manually embed SVN peg revisions into paths that will be processed by escaping functions.

**Issue** (v2.32.19):

- Repository Log diff commands failed with "path not found" error
- SVN error: `svn: E160013: '.../file.txt@367' path not found`
- Actual command sent: `svn log ... 'path@367@'` (double @)
- Root cause: Caller constructed `path@revision` then passed to `log()` method
- `log()` method called `fixPegRevision()` which added another `@` when it detected existing `@`

**Why this happens**:

```typescript
// BAD: Manual peg revision embedding
const pathWithPeg = `${remotePath}@${revision}`; // "file.txt@367"
await repo.log(..., pathWithPeg);
// log() calls fixPegRevision("file.txt@367") → "file.txt@367@"
// SVN interprets trailing @ as empty peg revision (HEAD)

// GOOD: Pass peg revision separately
await repo.log(..., remotePath, revision);
// log() calls fixPegRevision("file.txt") → "file.txt"
// Then appends "@367" → "file.txt@367"
```

**SVN Peg Revision Syntax** (corrected in 0.2.79):

- svn resolves the peg at the LAST `@` of a target
- `file@2024.txt@100` = file named "file@2024.txt" at peg 100 — CORRECT pegged form, no escaping
- `file@2024.txt@@100` = literal path "file@2024.txt@" at peg 100 — the escape-then-append bug
- `file@2024.txt@` = literal "file@2024.txt", no peg — the trailing-`@` escape is ONLY for peg-less targets

**Fix Pattern** (0.2.79):

```typescript
// fixPegRevision(path, peg?) owns the construction:
// with a peg → `${path}@${peg}` (unescaped);
// without   → trailing-@ escape when the path contains @
args.push(fixPegRevision(targetStr, pegRevision));
```

**Rule**: Pass peg revision as a separate parameter and construct the target in ONE place. Never pre-escape a path you're about to append a peg to — svn splits at the last `@`, so the escape corrupts the path.

---

### 25. Credential Lock Deadlock: No Nested retryRun Calls

**Lesson**: `credentialLock` in `retryRun()` causes deadlock when operations are nested within callbacks.

**Issue** (v2.32.20):

- "Update Revision" notification hung indefinitely after `svn update` and `svn info` completed
- Root cause: `updateRevision` callback called `await this.status()` which triggered nested `retryRun()`
- Parent `retryRun` held `credentialLock`, child `retryRun` waited for same lock = DEADLOCK

**Code path**:

```
run(Update, callback)
  → retryRun(callback)      // Acquires credentialLock
    → callback()
      → this.status()
        → run(Status)
          → retryRun()      // BLOCKED waiting for credentialLock!
```

**Fix**:

```typescript
// BEFORE: Nested run() call causes deadlock
await this.status(); // Calls run(Status) → retryRun()

// AFTER: Let parent run() handle model update
// run(Operation.Update) automatically calls updateModelState() after callback
void this.updateRemoteChangedFiles(); // Debounced, fires in background
```

**Why this works**:

- Every `run()` call with a non-read-only operation already calls `updateModelState()` after the callback
- Calling `this.status()` inside the callback was redundant AND caused the deadlock
- The fix removes the redundant call, letting the parent handle status refresh

**Rule**: Never call `run()` / `retryRun()` from within a `run()` callback. Let the parent handle post-callback work.

---

### 35. VS Code UX: Multi-Step QuickPick Patterns

**Lesson**: Use native VS Code QuickPick/InputBox for wizard-like flows, not webviews.

**Issue** (v2.33.0):

- Original commit UX required webview for commit message input
- Webview is heavy, context-switching, non-native feel
- Users expected Ctrl+Enter to commit like VS Code Git extension

**Fix**:

```typescript
// Multi-step QuickPick with step indicators
await window.showQuickPick(items, {
  title: "Commit (1/3): Select type", // Step indicator in title
  placeHolder: "Choose commit type"
});

// acceptInputCommand for Ctrl+Enter
sourceControl.acceptInputCommand = {
  command: "svn.commitFromInputBox",
  title: "Commit",
  arguments: [this]
};
```

**Pattern**:

1. Use QuickPick for selection steps (commit type, files)
2. Use InputBox for text entry (scope, description)
3. Title shows step progress ("1/3", "2/3", "3/3")
4. Final step shows confirmation with file preview
5. Wire `acceptInputCommand` for Ctrl+Enter from SCM input box

**Benefits**:

- Native VS Code look and feel
- Keyboard-driven (no mouse required)
- Faster than webview (no DOM rendering)
- Familiar to Git extension users

**Services**:

- `ConventionalCommitService`: Parse/format conventional commit messages
- `CommitFlowService`: Orchestrate multi-step QuickPick flow
- `PreCommitUpdateService`: Run SVN update in parallel with commit message input

**Rule**: Prefer native VS Code UI (QuickPick, InputBox, Progress) over webviews for simple workflows.

---

### 26. Optimistic UI Updates: Skip Status Refresh for SCM Operations

**Lesson**: For stage/unstage operations, update UI immediately without waiting for full `svn status` refresh.

**Issue** (v2.33.x):

- Stage/unstage called full `svn status --xml` after each SVN changelist operation
- Each status call: ~100-500ms depending on working copy size
- Multiple rapid stage operations = cumulative delay (user sees lag)

**Fix**:

```typescript
// BEFORE: Full refresh after every operation
await repository.addChangelist(files, STAGING_CHANGELIST);
await repository.updateModelState(); // Full svn status --xml

// AFTER: Optimistic UI update
await repository.addChangelist(files, STAGING_CHANGELIST);
groupManager.moveToStaged(files); // Move Resource objects directly
```

**Pattern**:

1. Execute SVN operation (addChangelist/removeChangelist)
2. Directly manipulate Resource groups in memory
3. Skip updateModelState() refresh
4. Eventual consistency: next status poll corrects any drift

**Implementation**:

- `moveToStaged(paths)`: Remove from changes/changelists, add to staged
- `moveFromStaged(paths, targetChangelist?)`: Remove from staged, add to target
- Both methods update staging cache via `syncFromChangelist()`

**When to use**:

- ✅ Operations with predictable outcome (stage = move to staged group)
- ✅ User expects instant feedback (<100ms)
- ✅ Background refresh will eventually correct state
- ❌ Operations with uncertain outcome (merge, update with conflicts)
- ❌ Critical operations where accuracy > speed

**Rule**: For predictable SCM operations, update UI optimistically. Let background refresh handle edge cases.

#### 26a. Batch UI-Notify Across Multi-Group Operations (v0.2.34)

**Issue**: `unstageWithRestoreOptimistic` grouped paths by destination changelist, then called `repository.unstageOptimistic` once per group + once for "remove". Each call fired its own `updateActionButton()` + `triggerInputValidation()` (the latter toggles `inputBox.value` twice to force VS Code re-validation). Unstaging files from N changelists = N rounds of action-button rewrites + 2N input-box toggles.

**Fix**: `unstageOptimistic` now accepts `Map<string|null, string[]>`. Helper builds the map once and dispatches a single batched call. SVN commands still run per-group (unavoidable — different destinations), but the UI notification fires exactly once via a new `notifyStagingChanged()` private.

**Rule**: For SCM operations that fan out to multiple SVN calls, run the SVN side per-group but emit ONE UI notification at the end. Let the action-button + input-box churn collapse to a single refresh.

#### 26b. Optimistic-Path Operations Must Set Grace Period (v0.2.35)

**Issue**: `stageOptimistic`/`unstageOptimistic` correctly bypass the `run()` wrapper to avoid the heavy `updateModelState()` after-effect. But they ALSO skipped `run()`'s side effect of setting `lastForceRefresh` — so when the SVN `changelist` command modified `.svn/wc.db`, the file watcher saw no grace period and reactively fired the very cascade we tried to avoid (`onDidAnyFileChanged` → `svn info`; `onFSChange` → debounced `svn stat`; `updateModelState` → `svn proplist -R -v .`; downstream listeners → sparse-checkout `svn list`). User saw 6 SVN commands per single-file stage.

**Fix**: Call `this.setGracePeriod()` at the top of optimistic stage/unstage. Grace period suppresses the immediate watcher reflex; only one delayed reconciliation status fires ~5s later (acceptable eventual consistency).

**Rule**: ANY method that does SVN writes outside `run()` must call `setGracePeriod()` itself. The grace period is the contract that tells the file watcher "I already know about this — don't react." Bypassing `run()` for performance still requires upholding that contract.

#### 26c. Expiry-Based Caches Need In-Flight Dedup (v0.2.36)

**Issue**: `refreshAllPropertyCaches` ran `svn proplist -R -v .` (the most expensive cache-refresh command — recursive over the entire working copy) and only pushed forward `propertyCacheExpiry` AFTER `getAllProperties` resolved. That left a window where:

```
t=0:   save #1 → updateModelState → expiry expired → fires proplist A (running…)
t=1s:  save #2 → updateModelState → expiry STILL expired → fires proplist B (concurrent)
t=1s+: fs event → updateModelState → expiry STILL expired → fires proplist C
```

Result: 3× concurrent recursive proplist calls per multi-save burst.

**Fix**: Track an in-flight Promise on the method (`_propertyRefreshInFlight`). Concurrent callers return the same Promise instead of starting fresh.

**Rule**: Any cache-refresh method gated by an expiry timestamp written AFTER its async work must also dedup in-flight callers. The expiry only protects against late callers; concurrent callers need promise-sharing.

#### 26d. Cache at the Right Layer — by Actual Resource, Not by URI (v0.2.37)

**Issue**: `svnFileSystemProvider.stat` has a 1-minute cache keyed by `uri.toString()`. Opening a diff editor invokes stat on two different svn-scheme URIs (e.g. `?rev=BASE` and `?rev=HEAD`) — same underlying file, different URI strings, two cache misses. Each fell through to `repository.list(fsPath)` → remote `svn list <URL>`. Two network round-trips for identical data.

**Fix**: Cache lower down, at `svnRepository.list()`, keyed by the URL we actually pass to SVN. Different URIs that resolve to the same URL now share the cached result.

**Rule**: When you see redundant network calls for the same resource, check whether higher-layer caches are keyed by _request shape_ rather than _target resource_. Move the cache to the layer where the key is canonical for the resource.

#### 26e. Normalize Implicit Defaults Before Caching (v0.2.38)

**Issue**: `svn cat <file>` (no `-r`) and `svn cat -r BASE <file>` return identical content for a working-copy path (SVN defaults to BASE there). Two consumers — `svnFileSystemProvider.readFile` (no rev) and `BlameProvider.computeLineMapping` (`"BASE"`) — both fetched the same content but produced different exec args, so the in-flight dedup never unified them.

**Fix**: At the args-prep layer, normalize `revision=undefined` → `"BASE"` when the path is a working-copy child. Now both callers produce the same args key. Paired with a short-TTL `_catCache` so the second call doesn't re-exec after the first completes.

**Rule**: Cache keys are only as good as their normalization. Equivalent inputs (SVN defaults, path slashes, case-insensitive segments) must collapse to the same key BEFORE cache lookup — otherwise the cache hit rate drops to zero for the most common case.

---

### 27. Native Resources: Track and Dispose Separately

**Lesson**: Native Node.js resources (FSWatcher, process handlers) must be explicitly tracked and disposed.

**Issue** (v2.33.2):

- `fs.watch()` watcher created but never added to disposables array
- Process event handlers (`exit`, `SIGINT`, `SIGTERM`) never removed
- File handles leaked when repository closed
- Handlers accumulated during development reloads

**Fix**:

```typescript
// BAD: Native watcher not tracked
const watcher = watch(path, callback);
watcher.on("error", handleError);
// Never closed!

// GOOD: Track and close in dispose
private nativeWatcher?: FSWatcher;

constructor() {
  this.nativeWatcher = watch(path, callback);
}

dispose(): void {
  if (this.nativeWatcher) {
    this.nativeWatcher.close();
    this.nativeWatcher = undefined;
  }
}
```

**Process handlers**:

```typescript
// BAD: Handlers never removed
process.on("exit", cleanup);
process.on("SIGINT", handler);

// GOOD: Store references, remove on dispose
const sigintHandler = () => {
  cleanup();
  process.exit();
};
process.on("SIGINT", sigintHandler);
disposables.push(
  toDisposable(() => {
    process.removeListener("SIGINT", sigintHandler);
  })
);
```

**Rule**: Native resources don't implement IDisposable. Track them separately and clean up in dispose().

---

### 46. Proposed APIs: Proceed with Extreme Caution

**Lesson**: VS Code proposed APIs can have internal bugs that make them unusable, even with correct implementation.

**Example** (SourceControlHistoryProvider - ABANDONED):

We implemented `scmHistoryProvider` for native Graph view support. Despite correct implementation:

- Runtime checks passed
- Provider registered successfully
- Methods implemented correctly

But VS Code's internal Graph view threw "Tree input not set" errors due to their own tree initialization bugs. No amount of timing adjustments (setImmediate, setTimeout, waiting for status updates) could fix VS Code's internal race condition.

**What We Tried**:

1. Immediate registration → Error
2. setImmediate delay → Error
3. setTimeout(100ms) → Error
4. Wait for first status update → Error

**Conclusion**: The bug was in VS Code's `WorkbenchCompressibleAsyncDataTree2._updateChildren` - their tree view wasn't initialized before they tried to update it.

**Rule**: Proposed APIs are unstable by definition. Even correct implementations can fail due to VS Code internal bugs. Always have a stable fallback (TreeView worked perfectly while Graph view failed).

**Recommendation**: Avoid proposed APIs unless absolutely necessary. Wait for them to become stable APIs before adoption.

---

### 47. History Filtering: Hybrid Server/Client Approach

**Lesson**: Leverage immutable data characteristics for aggressive caching.

**Context** (v2.35.0 - History Filtering):

SVN revision history is immutable and linear. This enables:

1. **LRU cache with infinite TTL** - Entries never invalidate (only evict by LRU)
2. **Server-side filtering** - Use SVN `--search` for text, `-r {DATE}` for dates
3. **Client-side filtering** - Action types (A/M/D/R) not supported by SVN

**Pattern**:

1. Check if filter uses server-supported features (--search, -r)
2. If yes → Call `logWithFilter()` with SVN args
3. If no → Use regular `log()` + client-side filter
4. Cache both raw and filtered results keyed by filter hash

**Benefits**:

- First query: SVN call → cache
- Same filter: instant cache hit
- Different filter on same data: client-side filter from cache

**Trade-off**: Memory usage grows with unique filter combinations (capped at 50 entries).

**Rule**: Immutable data enables aggressive caching. Split filtering between server (what it supports) and client (what it doesn't).

---

### 48. VS Code Native UX: Multi-Step QuickPick

**Lesson**: Prefer VS Code native UI patterns over custom solutions.

**Context** (v2.35.0 - History Filtering UX):

Initial implementation: 8 separate filter commands in toolbar menu. Overwhelming and non-standard.

**Better Pattern**:

1. **Single entry point** - One "Filter" button opens multi-step QuickPick
2. **Step 1**: Select filter type (shows current values in detail line)
3. **Step 2**: Enter value (pre-populated with current value)
4. **TreeView.description** - Shows active filter summary (not title change)
5. **Context variable** - `commands.executeCommand('setContext', 'key', value)`
6. **Dynamic visibility** - Clear button visible only when filter active

**VS Code UX Guidelines**:

- Use QuickPick for selection, InputBox for text entry
- Use description property for state display
- Use when clauses for dynamic menu items
- Avoid webviews when native UI suffices

**Rule**: Fewer toolbar buttons = better UX. Use multi-step QuickPick for complex operations.

---

### 49. Extension Rebrand: Uninstall Old Version

**Context** (v0.1.1 - Duplicate Extensions):

After rebranding extension (svn-scm → sven), having both old and new versions installed causes "already registered" errors for schemes/views.

**Symptoms**:

- "a provider for the scheme 'svn' is already registered"
- "Cannot register multiple views with same id"
- Double activation logs

**Root cause**: Two different extensions trying to register same schemes/views.

**Solution**: Uninstall old extension. That's it.

**Anti-pattern avoided**: Over-engineering activation guards based on speculation. We initially implemented multi-layered guards (module flags + command checks) when the fix was simply uninstalling the duplicate.

**Rule**: Diagnose root cause before implementing fixes. Trust VS Code's `context.subscriptions` pattern for cleanup.

---

### 28. DRY Helpers in Command Base Class

**Lesson**: Extract common patterns to base class helpers to reduce duplication across commands.

**Issue** (v0.2.1):

- 11 commands had `.filter(s => s instanceof Resource) as Resource[]`
- 22+ commands had `.map(r => r.resourceUri)`
- 7+ commands had `.map(u => u.fsPath)`
- Type casts (`as Resource[]`) are unsafe, lose type guard benefits

**Fix**:

```typescript
// In Command base class
protected filterResources(states: SourceControlResourceState[]): Resource[] {
  return states.filter((s): s is Resource => s instanceof Resource);
}
protected toUris(resources: Resource[]): Uri[] {
  return resources.map(r => r.resourceUri);
}
protected toPaths(uris: Uri[]): string[] {
  return uris.map(u => u.fsPath);
}
protected resourcesToPaths(resources: Resource[]): string[] {
  return resources.map(r => r.resourceUri.fsPath);
}
```

**Usage in commands**:

```typescript
// BEFORE: Inline patterns with unsafe cast
const selection = states.filter(s => s instanceof Resource) as Resource[];
const uris = selection.map(r => r.resourceUri);
await this.runByRepository(uris, async (repo, resources) => {
  const paths = resources.map(r => r.fsPath);
});

// AFTER: Concise, type-safe helpers
const selection = this.filterResources(states);
await this.runByRepository(this.toUris(selection), async (repo, resources) => {
  const paths = this.toPaths(resources);
});
```

**Benefits**:

- Type-safe: `filterResources()` uses type guard, not unsafe cast
- Concise: One-liners instead of inline patterns
- Discoverable: IDE autocomplete shows available helpers
- Consistent: All commands use same patterns

**Rule**: When you see the same pattern 3+ times across commands, extract to base class helper.

---

### 29. SVN --limit Applies BEFORE --search Filter

**Lesson**: SVN `--limit` restricts commits _searched_, not results _returned_.

**Issue** (v0.2.8):

- Author filter returned nothing if author had no commits in first 50
- Root cause: `svn log --limit=50 --search john` only searches first 50 commits
- If john's commits are older than those 50, search finds nothing

**SVN Documentation**:

> "if `--limit` is used, it restricts the number of log messages searched,
> rather than restricting the output to a particular number of matching log messages."

**Fix**:

```typescript
// BAD: --limit applied before --search
const args = ["log", `--limit=${limit}`, "--search", author];
// Searches only first 50, filters those

// GOOD: No --limit with text search, apply client-side
const args = hasTextSearchFilter(filter)
  ? ["log", "--search", author] // Search full history
  : ["log", `--limit=${limit}`]; // Use --limit when no text search

// After fetch, apply client-side limit
if (useTextSearch && entries.length > limit) {
  entries = entries.slice(0, limit);
}
```

**When to omit --limit**:

- ✅ Text search filters: `--search` (author, message, path)
- ❌ Revision/date range: `-r 100:200` (OK to use --limit)
- ❌ No filter: (OK to use --limit)

**Rule**: Never combine SVN `--limit` with `--search`. Search full history, truncate client-side.

---

### 30. Cache Validation: Use Document Version for Staleness Detection

**Lesson**: Caches tied to file content must validate against document version, not just URI.

**Issue** (v0.2.8):

- Blame annotations showed wrong line numbers after `svn update`
- Cache key was URI only - no version tracking
- External file changes (svn update, git pull) didn't invalidate cache
- Stale blame data had old line numbers that no longer matched

**Fix**:

```typescript
// BAD: Cache keyed by URI only
const cached = this.blameCache.get(uri.toString());
if (cached) {
  return cached.data; // Might be stale!
}

// GOOD: Validate document version
const currentVersion = editor.document.version;
const cached = this.blameCache.get(key);
if (cached && cached.version === currentVersion) {
  return cached.data; // Guaranteed fresh
}

// When caching, store version
this.blameCache.set(key, { data, version: currentVersion });
```

**VS Code document.version**:

- Increments on every change (edits, undo, external reload)
- Reset when document is closed and reopened
- Reliable indicator of content changes

**Rule**: For caches tied to file content, always store and validate `document.version`.

---

### 31. Line Mapping for Modified Files: LCS Algorithm

**Lesson**: When displaying per-line annotations for modified files, use diff-based line mapping.

**Issue** (v0.2.8):

- Blame decorations appeared on wrong lines when file had local modifications
- SVN blame returns line numbers for BASE (committed) version
- Working copy has different line numbers due to added/removed lines
- User sees blame info on content that doesn't match

**Solution**: LCS (Longest Common Subsequence) based line mapping

```typescript
// Compute mapping from BASE line numbers to working copy line numbers
const baseLines = await svn.cat(file, "BASE").split("\n");
const workingLines = editor.document.getText().split("\n");
const mapping = computeLineMapping(baseLines, workingLines);

// Apply mapping when creating decorations
for (const blameLine of blameData) {
  const mappedLine = mapping.get(blameLine.lineNumber);
  if (mappedLine === undefined) continue; // Line deleted
  const lineIndex = mappedLine - 1; // Apply decoration here
}
```

**Algorithm details**:

1. LCS finds exact line matches (unchanged lines)
2. Lines not in LCS checked for similarity (modified lines)
3. Context anchoring: if surrounding lines match, treat as modified
4. Deleted lines: mapping returns undefined, skip decoration

**Performance**:

- O(m\*n) for LCS where m,n are line counts
- Cached per document version
- Negligible for typical file sizes (<10ms for 1000 lines)

**Rule**: For annotations on committed data displayed in working copy, compute line mapping between BASE and working copy.

---

### 32. Shared Async Providers Need Ownership Epochs

**Lesson**: Clearing a shared cache does not cancel its pending work.

A singleton serving several repositories must validate repository owner,
monotonic owner generation, and document version before every async write or UI
apply. Deduplicate only immutable network fetches; each visible editor keeps its
own apply continuation and mapping. Repo open/close/status/mutations must
reconcile all affected visible splits, not only the active editor.

**Rule**: Shared async state needs explicit ownership epochs and per-consumer
apply validation.

---

### 33. Bound Quadratic Diffs Without Positional Guessing

**Lesson**: An LCS cell cap prevents OOM but must not discard every trustworthy
mapping in a large edited file.

Strip equal edges, run dense LCS only within a fixed cell budget, then use
unique exact-line anchors plus bounded gap mapping. Leave unresolved or
duplicate-heavy regions unmapped; positional fallback can attach blame to the
wrong content.

**Rule**: Preserve exact sparse evidence; never trade OOM prevention for false
attribution.

---
