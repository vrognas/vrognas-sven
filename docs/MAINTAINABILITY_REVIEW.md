# Sven Architecture & Maintainability Review

_Prepared for the solo maintainer. Findings below reuse the review's own **corrected** severity/effort where the verifier revised the original claim. `confirmed` = verified against code; `plausible` = real smell but the recommendation carries a caveat, flagged inline._

---

## 1. Executive summary

Five structural themes dominate, in rough order of leverage:

1. **God objects with no seams.** `repository.ts` (3010 LOC), `svnRepository.ts` (2750), `command.ts` base class (1176), `blameProvider.ts` (1539), `sparseCheckoutProvider.ts` (1516), `ResourceGroupManager.ts` (806), and the `run()`/`retryRun()`/`executeProcess` pipelines each fuse 5-7 concerns. None can be unit-instantiated, so the core logic is only reachable through binary-gated E2E that skips locally. This is the root cause behind most other findings.

2. **Everything binds to concrete classes; interfaces exist but are bypassed.** ~131 `: Repository` couplings vs. an `IRemoteRepository` seam used in 3 files; services depend _up_ on the concrete god object; the SCM singleton is triple-wired via a service-locator. Consumers pull the whole god object into every test and every type definition.

3. **Duplication with silent drift.** Error-message extraction (~9 inline copies), SVN error-code regexes (4 variants), the inline-decoration loop (3 copies), TtlCache logic, the two log providers, and the per-method delegation/exec boilerplate all repeat, and several have _already diverged_ — bugs fixed in one copy and not the other.

4. **Error handling is a convention, not a contract.** `SvnError` doesn't extend `Error`, so `instanceof Error` is false exactly when a real SVN error occurred → users see "Unknown error." Four competing report-to-user patterns coexist, some catches swallow silently, and a rich `handleOperationError` pipeline exists that most commands bypass.

5. **Guardrails enforce nothing.** Async-safety and `no-explicit-any` lint rules are all `warn`; CI has no `--max-warnings 0`, so warnings are decorative. There is no filename-case rule, no import-cycle rule, no console-ban, no composition root.

**Single highest-leverage move:** _Add the cheap, cross-cutting foundations before touching any god object_ — (a) make `SvnError extends Error` and route all error formatting through the one existing `getErrorMessage`, and (b) promote the two zero-violation async-safety lint rules to `error`. These are small, mostly-confirmed, fix a real user-facing bug (F14), stop further decay, and every later refactor rides on them. Decomposition of the god objects is the larger prize but must come _after_ seams exist.

---

## 2. What's already solid — do not touch

- **The services extraction is genuinely started and partly exemplary.** `RemoteChangeService` is vscode-free with injected hooks (F11, F53) — the correct pattern. `StatusService`, `ResourceGroupManager`, `StagingService` are real extractions. Keep this direction; the fix is to make the _other_ services follow `RemoteChangeService`, not to undo it.
- **Reusable primitives already exist** — `withCachedInFlight` (with `ttlOverrideMs` and an owner-guard), `util/lruCache`, `getErrorMessage`, `parseXml`, `getSvnErrorCode`, the `handleOperationError` chain. The problem is under-use, not absence. Don't build new ones; route callers to these.
- **TDD discipline is real and load-bearing.** `blameInvalidation.test.ts`, `repoLogProvider.refresh.test.ts`, the parser suites, the branch-pinning tests. This is the safety net that makes the risky refactors below tractable. Preserve it.
- **The build split is idiomatic, not broken** (F16, F39, F38). esbuild-ships / tsc-typechecks / c8-instruments-E2E is the recommended VS Code pattern. Node 16 target down-levels almost nothing. Leave the three-config structure alone; only document it.
- **Runtime is correct.** Nearly every finding is maintainability/testability, not a live bug. The async-constructor cast, the LateInit/Async split, the cache ordering in `run()` — all currently work. Treat these as cleanup, not firefighting.

---

## 3. Prioritized findings by theme

### A. Type-safety & error handling _(highest impact-to-effort — start here)_

- **Make `SvnError` a real `Error`; add `isSvnError` guard; unify the type model.** `SvnError` doesn't extend `Error`, so genuine SVN failures fall through to "Unknown error" in `manageAutoProps`/`command.ts:1121`. Three overlapping shapes (`ISvnErrorData`, `SvnError`, `ErrorLike`), 8 unchecked `as ISvnErrorData` casts, `svnErrorCode` typed as bare `string`. Add `Object.setPrototypeOf`, collapse to one type behind an exported `isSvnError`, type the code as the enum union. _Caveat: making it extend `Error` flips `instanceof` sites to read `err.message` instead of stderr — a user-visible message change; existing error-formatting tests will catch it, land incrementally behind the guard._
  `Impact:high · Effort:medium · Sev:medium · [confirmed] · evidence: src/svnError.ts:11, common/types.ts:284,291`

- **Route every inline error-extraction through the one `getErrorMessage`.** ~9 hand-written `error instanceof Error ? ... : "Unknown error"` copies that have already drifted ("Unknown error" / "" / "Failed to stat file"). Three coercion helpers (`getErrorMessage`, `buildErrorContext`, `sanitizeError`) overlap. _Caveat: `buildErrorContext`/`sanitizeError` duck-type on `.message` of non-`Error` SVN objects — do NOT blindly fold them into the `instanceof`-based helper or you drop those messages. Fixing F14 first removes this caveat._
  `Impact:high · Effort:small · Sev:medium · [plausible] · evidence: src/util/errorLogger.ts:69; manageAutoProps.ts:193,239,270,330; command.ts:1121`

- **Promote the two async-safety lint rules to `error` now; ratchet `any` later.** All async-safety + `no-explicit-any` rules are `warn`; CI lacks `--max-warnings 0`, so warnings never fail a build. There are currently **0** `no-floating-promises`/`no-misused-promises` violations, so promoting those two is free. _Caveat: `--max-warnings 0` or promoting `require-await` would break CI on 25 existing benign warnings — do that as phase 2 after cleanup._
  `Impact:high · Effort:small (phase 1) · Sev:medium · [confirmed] · evidence: eslint.config.js:40,54-57; package.json:54`

- **Standardize SVN error-code detection + parse handling.** Three parse philosophies (wrap+throw / call-with-no-handling / silent `[]`) and four regexes for the same code (`E(\d+)`, `E\d+|W\d+`, `E\d{6}`). Add one **general** `svnErrorHasCode(err,code)` extractor and a documented swallow convention. _Caveat: must be a general `E\d{6}/W\d{6}` extractor, NOT `getSvnErrorCode` (an allowlist) — that would drop W-code/unknown-code detection `svnFileSystemProvider` intentionally uses._
  `Impact:medium · Effort:medium · Sev:medium · [plausible] · evidence: svnRepository.ts:713-715,1243; svnFileSystemProvider.ts:389; errorUtils.ts:17`

- **Route commands through the existing `handleOperationError` pipeline.** `setDepth`, `manageAutoProps`, `manageEolStyle`, `needsLock` re-implement bare `exitCode`/stderr toasts and duplicate cleanup-detection, so users hitting auth/lock errors there get no recovery prompt. _Caveat: `executeWithFeedback` does NOT itself call `handleOperationError`, and batch commands loop over many paths — naive wrapping spams N prompts. `setDepth` (single op) is the clean, safe win; the batch case needs a collect-then-prompt design._
  `Impact:medium · Effort:medium · Sev:medium · [plausible] · evidence: command.ts:997-1085; setDepth.ts:491-532; manageAutoProps.ts:180-333`

- **Extract `classifyBlameError`; move toasts out of the fetch path.** Untracked/auth/network code lists duplicated between `blameProvider` and `blameStatusBar`; auth-prompt UI lives inside the data-fetch method. _Caveat: `getBlameData` has two internal callers — keep the reaction centralized in one wrapper, don't push it into both._
  `Impact:medium · Effort:small · Sev:low · [confirmed] · evidence: blameProvider.ts:863-921; blameStatusBar.ts:334-348`

- **Add a `no-console` rule for `src/**`(allow`errorLogger.ts`).** Credential-sanitizing `logError`is a convention only;`repository.ts:1694`passes a raw SVN error to`console.warn`. *Caveat: land as `warn`first — ~7 prod files (extension.ts diagnostics) need case-by-case conversion.*`Impact:medium · Effort:small · Sev:low · [confirmed] · evidence: util/errorLogger.ts:5-41; repository.ts:1694`

- **Discriminated union for `ILogTreeItem`.** `kind` and `data` are independent, so the compiler can't narrow — every handler casts, a wrong cast compiles. _Caveat: needs 4 arms (include the `Repo→SvnPath` arm); does NOT fix the separate `parent?` optionality the finding conflates._
  `Impact:medium · Effort:medium · Sev:low · [confirmed] · evidence: historyView/common.ts:89-97; repoLogProvider.ts:259`

- **Add a copy-helper to `Resource`; the 12-arg clone already drops a field.** `mergePreservedLockStatus` rebuilds `Resource` from 12 positional args and silently omits `_propertyChanges` — a live latent bug proving the trap. Add `withLock()`/options-object ctor. _Caveat: the second half (consolidating lock preservation into `StatusService`) is riskier; ship the helper as its own commit._
  `Impact:medium · Effort:medium · Sev:medium · [confirmed] · evidence: ResourceGroupManager.ts:261-274; StatusService.ts:425-439`

- **Delete the dead `>=1.21` VS Code shims; add a runtime guard at `openChange`.** `engines.vscode ^1.109.0` makes those `as unknown as` branches provably dead. _Caveat: do the shim cleanup + the one `resourceStates as Resource[]` guard; defer the base-class generic on `execute` — it fights `registerCommand`'s dynamic dispatch for little gain._
  `Impact:low · Effort:medium · Sev:low · [plausible] · evidence: command.ts:105,687; checkout.ts:184-188,242-267`

- **Typed test mocks (partial).** 893 `as any` + 604 `Partial<Repository>` fakes mean signature changes compile green. _Caveat: role interfaces only address ~28% (the Repository-shaped mocks); the majority are private-method/global reach-ins. Do seam-by-seam, not big-bang._
  `Impact:medium · Effort:large · Sev:medium · [plausible] · evidence: src/test (893 as any); commit.test.ts:46-58`

### B. Dead code & vestigial infrastructure _(cheap, clarifying wins)_

- **Resolve the `AuthService` fork — delete it.** A fully-built, fully-tested auth module with **zero non-test importers**; `repository.ts` re-implements the ladder inline and the live `retryRun` is a _superset_ (credential mutex, quadratic + jittered backoff) the dead copy lacks. A dev who "wires it up" would silently regress. Delete `authService.ts` + its one false-coverage test (option a). _Note: only `authService.test.ts` gives false coverage — `authRegression.test.ts` tests real code._
  `Impact:high · Effort:small · Sev:medium · [confirmed] · evidence: src/services/authService.ts:46-209; repository.ts:2329-2401`

- **Collapse the vestigial multi-repo log cache.** `Map`/hand-rolled LRU/`order`/`userAdded`/`removeRepo` for a cache that returns `.values().next().value`; `userAdded` is read but never assigned. Delete the unambiguously-dead fields first. _Caveat: `refresh()` genuinely keys per-repo for multi-root workspaces and holds recently-fixed staleness logic — collapse `Map→currentCache?` carefully, and `removeRepo` removal needs package.json menu cleanup._
  `Impact:medium · Effort:medium · Sev:medium · [confirmed] · evidence: repoLogProvider.ts:60,72-121; historyView/common.ts:74,76`

- **`git rm` the stale `.vsix` binaries; broaden ignore to `*.vsix`.** Two orphaned `positron-svn-2.37.0.vsix`/`-deprecated.vsix` (~171KB each) from the old product identity; `.gitignore` only covers `sven*.vsix`. _Caveat: `git rm` untracks going forward only; history rewrite not advised._
  `Impact:medium · Effort:small · Sev:low · [confirmed] · evidence: .gitignore; package.json (name=sven 0.2.69)`

- **Delete the `[key:number]:IFileStatus` self-referential index signature.** Bogus, weakens checking, zero numeric-index usages. Isolated verified fix, confirm `tsc` passes.
  `Impact:low · Effort:small · Sev:medium · [plausible, this sub-item confirmed] · evidence: common/types.ts:214`

### C. Coupling & layering

- **Introduce role interfaces so services stop depending on the concrete god object.** `commitFlowService`/`preCommitUpdateService` import concrete `Repository` and reach into 7 methods; same folder, opposite dependency directions from `StatusService`. Define `IResourceLookup`/`IUpdatable`/`ICommitInput`, mirroring `RemoteChangeService`. _Caveat: there is NO actual import cycle (services→Repository one way); "cannot unit-test" is overstated (`preCommitUpdate.test.ts` already uses a partial mock). Real smell, additive fix. Note: use dependency-cruiser/eslint `import/no-cycle`, NOT the Python "import-linter" the finding names._
  `Impact:medium · Effort:medium · Sev:medium · [plausible] · evidence: commitFlowService.ts:10; preCommitUpdateService.ts:6`

- **Inject the SCM singleton instead of the triple-wired service-locator.** Reachable three ways (static field, IPC round-trip, ctor injection); every command's real dependency is hidden behind an async getter with an IPC fallback for an in-process object. _Caveat: effort is **large**, not medium — base ctor change ripples to ~70 subclasses; `messages.ts` is a non-Command consumer the plan omits; the static field is an intentional perf cache. Sound direction, underestimated blast radius._
  `Impact:high · Effort:large · Sev:medium · [plausible] · evidence: command.ts:82-120; helpers/sourceControlManager.ts:7-12`

- **Give `BlameProvider` constructor-injected config/state (singletons as default args) and narrow `Repository` methods.** Per-repo providers share one global `blameStateManager`/`blameConfiguration`; `repository.repository.show(...)` drills two layers into inner `SvnRepository`. Add `showBase(uri)`/`authUrl`. _Caveat: singletons must remain the shared default in prod (status bar imports the same one). Standard DI; touches ~40 test sites._
  `Impact:medium · Effort:medium · Sev:medium · [confirmed] · evidence: blameProvider.ts:24-25,902,952; blameStateManager.ts:133`

- **Type the core repo-lookup seam.** `getRepository(hint: unknown)` sniffs 5+ shapes; `getRepositoryFromUri` is a divergent parallel resolver that omits the excluded-paths check. Split into `getRepositoryForUri/Resource/SourceControl`, fold the duplicate into the one exclusion-aware path. _Caveat: folding changes behavior for changelist ops that currently get lenient resolution — confirm intended; tests pass string/object hints._
  `Impact:medium · Effort:medium · Sev:medium · [confirmed] · evidence: source_control_manager.ts:373-460`

- **Break the `common/types.ts ↔ Repository` type cycle cleanly.** Lowest-level type module imports the highest-level god class for 3 interface members. _Caveat: NO runtime cycle (types elided at emit), so harms are modest; a clean fix needs a dedicated `repository-types` module — retyping on `IRemoteRepository` breaks consumers, relocating re-forms the cycle. Mostly cosmetic._
  `Impact:low · Effort:medium · Sev:low · [plausible] · evidence: common/types.ts:8-9; repository.ts:87; resource.ts:13`

- **Concrete `Repository` coupling (131 sites) / no DI in its constructor.** These two (F30, F31) are the "why the god object is untestable" pair; both are large and best deferred until seams above exist. Repository news up 5 collaborators inline (`RemoteChangeService` shows the injectable pattern it doesn't apply). Deliver via a `RepositoryDependencies` struct + static `create()` factory, characterization tests first.
  `Impact:high · Effort:large · Sev:medium · [plausible] · evidence: repository.ts:148,377-471`

### D. God objects & decomposition _(the large prize — sequence carefully)_

Order within this theme: extract _pure_ slices first (safe, testable), stateful/lifecycle slices last.

- **`run()`/`retryRun()` operation pipeline — the untestable core seam.** Interleaves lifecycle events, progress UI, grace timing, cache invalidation, refresh decisions, dispose, and the whole auth-retry ladder. Extract an `OperationRunner` with injected auth-strategy/cache-hook/progress/refresh collaborators. _Caveat: ordering is load-bearing and commented (cache-clear MUST precede `updateModelState` and `onDidRunOperation`); credential mutex must survive. Characterization tests before touching._
  `Impact:high · Effort:large · Sev:medium · [plausible] · evidence: repository.ts:2225-2401`

- **Base `Command` god object.** One abstract base every 79 commands extend, mixing registration, ~270 lines of diff-presentation, patch/revert, `sanitizeStderr` (9 regex), and error routing. Extract `DiffPresenter` + `SvnErrorReporter` via composition; keep `Command` owning registration + repo resolution. _Caveat: protected methods are called directly by subclasses — need delegating wrappers or ~66 call-site updates; regression-test the auth>lock>cleanup>update>conflict chain first._
  `Impact:high · Effort:large · Sev:medium · [confirmed] · evidence: command.ts:80-1176`

- **`blameProvider.ts` (1539 LOC).** Fuses fetch, cache, line-mapping, color math, SVG, message fetch, formatting, rendering. Extract `RevisionColorizer`, SVG, formatting (pure — lift first), then `BlameMessageService`, then `BlameCache` last. _Caveat: cache holds recently-fixed invariants (monotonic LRU, doc-version keying, coherent color key) — extract the stateful cache last, guarded by the Vitest blame suites._
  `Impact:high · Effort:large · Sev:medium · [confirmed] · evidence: blameProvider.ts:45-83,1118-1538`

- **`sparseCheckoutProvider.ts` (1516 LOC, 6× next-largest, zero tests).** `checkoutItems()` is one ~420-line method; `excludeItems()` a near-duplicate. Split into thin provider + `SparseItemService` + `SparseDownloadRunner`/`SparseExcludeRunner` sharing an error helper. _Caveat: completely untested — write characterization tests + inject `window.withProgress`/the file-poll monitor first, or you're just moving code._
  `Impact:high · Effort:large · Sev:medium · [confirmed] · evidence: sparseCheckoutProvider.ts:340-1516`

- **Extract the pure utilities trapped in the sparse provider _now_ (do this before the split above).** `pLimit` (a general limiter, used nowhere else) and the `createFileSizeMonitor`/`createFolderMonitor` speed/ETA math have nothing to do with `TreeDataProvider`. Mechanical move to `util/pLimit.ts` + `sparse/downloadProgressMonitor.ts`. _Nearly risk-free; check `util/batchOperations.ts` for an existing limiter first._
  `Impact:medium · Effort:small · Sev:low · [confirmed] · evidence: sparseCheckoutProvider.ts:48-68,146-338`

- **Property/lock cache subsystem (~500 lines, weakest cohesion) → `PropertyCacheService` + `LockStatusCache` + one `PathKey` normalizer.** Four near-identical path normalizers; a confirmed dual-key hazard (lock cache written with one key derivation, read with two). _Caveat: mutating methods are entangled with the Operation queue and event emitters — the service takes injected callbacks or write methods stay in Repository; `updateLockCache` appears dead, remove it._
  `Impact:high · Effort:large · Sev:medium · [plausible] · evidence: repository.ts:202-248,2464-2955`

- **`ResourceGroupManager` second god object (806 LOC).** Extract `ResourceIndex` (the cleanly-separable piece) + `StagedMutations`. _Caveat: "half scale"/"unrelated" overstated — all four clusters share heavily-mutated group state, so helpers risk feature-envy (moving coupling, not removing it). Modest structural gain, high test churn._
  `Impact:medium · Effort:large · Sev:low · [plausible] · evidence: ResourceGroupManager.ts:435-743`

- **`svn.ts executeProcess` (~270 lines, 7 concerns).** Extract `collectProcess(child,{timeoutMs,token})` (clean, testable) and `buildAuthArgs`. _Caveat: `buildAuthArgs` mutates args in place + does an async credential-cache write — preserve arg ordering (redaction depends on it) and cleanup/`clearTimeout` semantics._
  `Impact:medium · Effort:medium · Sev:medium · [confirmed] · evidence: svn.ts:275-542`

- **`refresh()` cache-reconciliation god method (~140 lines, 5 boolean flags, 4 parallel snapshots).** Split `pageMore`/`pruneAutoRepos` (trivially safe) from a pure `reconcileCache(prev,rev,{clear}) → enum(Keep|Clear|MoveBase)`. *Caveat: highest-regression-risk code in the subsystem; extend the branch-pinning test to hit the pure function *before* refactoring; keep the two extractions as separate commits.*
  `Impact:high · Effort:medium · Sev:medium · [confirmed] · evidence: repoLogProvider.ts:830-968`

- **270 lines of filter-QuickPick wizard embedded in `RepoLogProvider`.** Extract `HistoryFilterController` emitting filter changes (the `onDidChangeFilter` seam already exists). _Caveat: `promptFilterAuthor` reads `logCache` — inject an author-supplier; `treeView.description` update must stay in the provider._
  `Impact:medium · Effort:medium · Sev:medium · [confirmed] · evidence: repoLogProvider.ts:480-795`

- **`common/types.ts` + `util.ts` grab-bag hubs.** Domain constants (`isReadOnly`, `getSvnDir`, `fixPegRevision`) sit in generic `util.ts`; `util.ts`-file vs `util/`-folder ambiguity; `helpers/` all import `../repository`. Split by domain; add a lint rule against new catch-all additions. _Caveat: 100+ dependents = high merge-conflict churn for cosmetic gain; do NOT "reuse VS Code's LineChange" (not in stable typings — the local decl is deliberate). Only the `[key:number]` deletion is a safe standalone._
  `Impact:medium · Effort:large · Sev:medium · [plausible] · evidence: common/types.ts (456 LOC); util.ts:238-352`

### E. Duplication

- **Triplicated inline-decoration loop, already drifted.** Three verbatim copies of map-line→bounds→skip→build `DecorationOptions`; current-line filtering diverges per copy. Extract one `buildInlineDecoration(...)`. _Caveat: builder takes the already-resolved message string + lineIndex — leave message retrieval (async vs sync cache) and loop control at call sites to preserve the cursor path's fast-path._
  `Impact:high · Effort:medium · Sev:medium · [confirmed] · evidence: blameProvider.ts:460-513,523-615,1049-1076`

- **Two log providers duplicate the whole `TreeDataProvider` scaffold, with drift** (debounce 100ms vs 1000ms; filter tracked in one). Extract `BaseLogProvider` for EventEmitter/treeView-guard/visibility-deferral/Commit `getTreeItem`/load-more/`getParent`. _Caveat: leave `refresh()`/`getChildren()` per-subclass (Map+LRU+filter vs single `currentItem`); make the debounce merge a deliberate decision._
  `Impact:high · Effort:large · Sev:medium · [confirmed] · evidence: repoLogProvider.ts:50-140; itemLogProvider.ts:43-79`

- **Blame cache: 8 ad-hoc Maps, two eviction policies, LRU tracked separately, scattered invalidation** (`dispose` clears 7, `onRepositoryOperation` clears 4). Back the real data caches with the existing `util/lruCache`. _Caveat: do NOT fold in the disposable-decoration-handle maps (`iconTypes`/`svgCache`) — a generic clear leaks GPU handles; keep the in-flight dedup map separate; the "status bar shares one layer" sub-rec is weak (they already share `_blameCache`)._
  `Impact:medium · Effort:medium · Sev:medium · [plausible] · evidence: blameProvider.ts:52-68,345-385`

- **Copy-pasted TTL cache in the sparse provider (2 caches).** Introduce `TtlCache<K,V>` with `getOrLoad`. _Caveat: `getDepth` must NOT cache on error (preserve retry); current eviction is expiry-only — keep parity or intentionally add a real bound._
  `Impact:low · Effort:small · Sev:low · [confirmed] · evidence: sparseCheckoutProvider.ts:99-109,717-792`

- **`fs/` = 10-12 near-identical promisify wrappers with a split backend.** `chmod.ts`/`rename.ts` import `fs` while 9 others import `original-fs`; `chmod` creates a _second_ stat wrapper. Collapse to one `fs.ts` on one backend (barrel keeps import sites stable). _Caveat: "correctness hazard" overstated — `original-fs` only differs inside `.asar`, which this extension never touches; preserve the custom `exists()` and promisify overload typings._
  `Impact:medium · Effort:small · Sev:low · [confirmed] · evidence: src/fs/chmod.ts:4-8, stat.ts:8, rename.ts:4`

- **Property-command family duplicates list/pick/apply scaffolding with inconsistent dispatch.** `manageEolStyle` routes via fragile `label.includes(...)` while others use typed action ids. _High-value safe slice: standardize on typed action ids, drop `label.includes`._ _Caveat: the full template-unification over-reaches — `manageAutoProps` (config editor) and `manageLocks` (not svn: properties) don't fit; premature-DRY risk._
  `Impact:medium · Effort:medium · Sev:low · [plausible] · evidence: manageEolStyle.ts:83,148,174; manageAutoProps.ts:82-135`

- **Parser inconsistency: `lockParser` bypasses `parseXml`, `parse()` returns `any`, transforms hand-roll casts.** Route `lockParser` through a sync `parseXmlSync` sibling sharing the error wrapper; retype `parse()` as `unknown`. _Caveat: `parseXml` is async — don't route the sync lock path through the Promise wrapper; skip the "validating decoders everywhere" scope creep._
  `Impact:medium · Effort:medium · Sev:medium · [plausible] · evidence: lockParser.ts:33-124; logParser.ts:12-24; xmlParserAdapter.ts:245`

- **Larger deferred dedup (all `large`, mostly `plausible`/`low`):** the 53+ per-method `run(Operation.X)` delegation wrappers (F20 — _do NOT Proxy/string-dispatch; it erases type safety and the Operation tag is load-bearing, not boilerplate; at most extract the ~10 genuine passthroughs_); the 68 exec sites → command core `runXml/runText/runBuffer` (F21 — _add `runXml` incrementally, keep buffer/string pairs separate_); the two cache abstractions where blame+info hand-roll ~350 lines (F22 — _`withCachedInFlight` already has TTL + owner-guard; scope tightly, don't build a mega-primitive_); two tree paradigms (F28 — _extract a shared `RepoRootNode<T>` + helpers, don't rewrite the history data model while it's churning_).

### F. Testability

- **No composition root: services mix injection with hard `new`.** `PreCommitUpdateService` is welded into `CommitFlowService`; `SvnAuthCache` newed in the transport layer. Thread optional trailing ctor params (keep `?? new X()` defaults). _Caveat: modest value — `StagingService` is a dependency-free cache already tested fine; `CommitFlowService` is transient (per-invocation in `commitHelper`), doesn't fit "per-repository composition."_
  `Impact:low · Effort:medium · Sev:low · [plausible] · evidence: ResourceGroupManager.ts:180; commitFlowService.ts:60; svn.ts:259`

- **`XmlParserAdapter` couples pure parsing to the config singleton + a shared mutable parser.** Move `maxTags` into `ParseOptions`. _Caveat: 3 production callers (not "single"), each must read+forward `configuration.get(...)` or silently revert to the 500k default — a quiet security-policy regression risk._
  `Impact:low · Effort:small · Sev:low · [plausible] · evidence: xmlParserAdapter.ts:96-131,253-256`

- **Test harness: two parallel roots (`src/test` 111 files vs `test/` 85), inconsistent lint/run.** `eslint` ignores `src/test/**` entirely; `.vscode-test.mjs` hand-lists 7 files. _Caveat: enabling lint surfaces error-level violations across 111 files; `src/test` files are dual-run (vitest + electron) so a naive glob double-executes — needs an e2e naming convention first._
  `Impact:medium · Effort:medium · Sev:medium · [plausible] · evidence: eslint.config.js:9; vitest.config.ts:9-14; .vscode-test.mjs:5-11`

- **Test-harness style: 116 manual reassignments of VS Code exports (violates CLAUDE.md's own rule).** Standardize on `vi.spyOn(...).mockImplementation(...)` (auto-restored) + lint-ban `as any` assignment to vscode exports. _Caveat: do the spyOn migration now; treat the "fake-svn-cli fixture" as a separate deferred decision — a faithful fake is large effort and risks testing the fake, not svn._
  `Impact:medium · Effort:large · Sev:medium · [plausible] · evidence: open.test.ts:55,103; vitest.config.ts`

- **FS-event refresh scheduler tangled into the model, mutated from 3 sites.** Extract a `RefreshScheduler` with `requestRefresh(reason)`. _Caveat: timing constants (5s/1s/200-500ms) are delicately tuned and thinly tested — characterization tests first; do NOT bundle the staging-orchestration move (compounds risk)._
  `Impact:medium · Effort:large · Sev:medium · [plausible] · evidence: repository.ts:869-979\*

### G. API design & naming/organization

- **Async-constructor anti-pattern: constructors return Promises via `as unknown as`.** Replace with `static async create()` + private sync ctor, for both SCM and Repository. _Caveat: `ConstructorPolicy` LateInit vs Async is a real eager/lazy switch, not pure ceremony — map Async→`create()` (runs `updateInfo`), LateInit→plain ctor; a botched split silently skips `updateInfo`._
  `Impact:medium · Effort:medium · Sev:medium · [confirmed] · evidence: source_control_manager.ts:109-127; svnRepository.ts:150,161`

- **Command registration: hand-maintained flat `new+push` list, IDs stringly-duplicated across ctor/package.json/call sites with nothing validating agreement.** _Highest-value low-risk slice: a test asserting registered IDs match `package.json contributes.commands`_ (catches "command not found"). Registry array + ID-constant colocation is the larger, optional part. _Only `PickCommitMessage` truly needs the special-arg hook._
  `Impact:medium · Effort:medium · Sev:medium · [confirmed] · evidence: commands.ts:93-196; setDepth.ts (super('sven.setDepth'))`

- **`ConventionalCommitService` no-arg default silently drops all commit types.** _Caveat: latent smell, not an active defect — the only production site (`commitHelper.ts:168`) passes types correctly and the degraded path is gated off. Make `configuredTypes` required (TS forces callers); trivial test updates._
  `Impact:medium · Effort:small · Sev:low · [plausible] · evidence: commitFlowService.ts:57-60; conventionalCommitService.ts:57-115`

- **`original-fs` mislabeled as devDependency though imported by 9 runtime files.** Move to `dependencies` (one line). _Caveat: do NOT externalize (changes runtime resolution to Electron's ASAR-bypass semantics); skip the unrelated fs-collapse._
  `Impact:low · Effort:small · Sev:low · [plausible] · evidence: package.json:128; build.js:9`

- **Redundant formatting/coverage toolchains.** _Caveat: 3 of 4 "formatters" are dead devDeps that never run (eslint wires neither prettier plugin; `prettylint` referenced nowhere) — so "configs disagree"/"double pass" is false. Safe cleanup: drop `prettylint` + `eslint-plugin-prettier` + duplicate `test:fast`. Do NOT drop `c8` — it covers the Electron E2E tier vitest's v8 can't reach._
  `Impact:low · Effort:small · Sev:low · [plausible] · evidence: package.json:121-130,70`

- **Naming: rename `temp_svn_fs.ts` → `svnTempFileSystemProvider.ts` (it's production-wired, not scratch).** Mechanical rename is the safe part. _Caveat: the bundled "drop the module-level singleton" is riskier (module-scope imports in tree-command handlers) — defer it._
  `Impact:low · Effort:medium · Sev:low · [plausible] · evidence: temp_svn_fs.ts:61,320; extension.ts:32`

- **Three file-naming conventions (7 snake_case, PascalCase/camelCase mixed in `services/`).** Add an ESLint filename-case rule; `git mv` outliers. _Caveat: case-only renames on Windows silently drop from git → break case-sensitive CI; do isolated forced/two-step renames and run Linux CI. Cosmetic; needs `eslint-plugin-unicorn`._
  `Impact:low · Effort:medium · Sev:low · [plausible] · evidence: source_control_manager.ts, ignoreitems.ts; services/ mix`

- **Deferred/low-priority structural (`large`, mostly `low` corrected):** remote server-knowledge tracking split awkwardly from `RemoteChangeService` (F41); SCM presentation strings hard-coded in the domain model (F42 — _SourceControl is the command-identity hub; large, do incrementally_); `init()` god function (F57 — _the finding's "async dispose can't complete" claim is FALSE — `dispose()` is synchronous; keep the signal handlers, just extract `buildServices`/`registerUi`_); per-property method explosion (F44 — _wrappers carry typed values/documented defaults; debatable tradeoff_); command-layer reach-through `repository.repository.*` (F61 — _only 2 call sites; add one `Repository.removeAbsolutePath` delegate_); `src/` root sprawl (F66 — _folders don't enforce boundaries in TS; high churn, no coupling reduction — low priority; but DO move/gitignore `src/.remember`_).

---

## 4. Suggested sequencing

**Guiding principle (from the data itself): add seams before splitting.** Nearly every god-object recommendation is `plausible` precisely because the load-bearing ordering/cache-coherence/mutex logic has no unit safety net. So the foundation and quick wins come first, characterization tests second, splits last.

### Phase 0 — Quick wins (days, low risk, high clarity)

Do these in any order; they're mostly independent and mostly `confirmed`:

1. **Delete `AuthService` + its false-coverage test** (F04) — removes a 360-line regression trap.
2. **`git rm` stale `.vsix` + broaden `.gitignore`** (F37); **move `original-fs` to `dependencies`** (F38); **drop dead formatter devDeps + `test:fast`** (F39); **gitignore/move `src/.remember`** (F66 sub).
3. **Delete the `[key:number]` index signature** (F29 sub), confirm `tsc`.
4. **Extract `pLimit` + download monitors** out of the sparse provider (F55) — pure move, immediate testability.
5. **Add the command-ID ↔ package.json agreement test** (F32 slice) — catches "command not found" silently.

### Phase 1 — Foundations (the highest-leverage block; unblocks everything)

1. **`SvnError extends Error` + `isSvnError` guard + unify the error type model** (F14) — fixes the real "Unknown error" user bug; land incrementally behind the guard.
2. **Route inline error-extraction through `getErrorMessage`** (F02) and **add `classifyBlameError`** (F33) — trivial once F14 removes the duck-typing caveat.
3. **Promote `no-floating-promises`/`no-misused-promises` to `error`** (F03 phase 1, zero current violations); **add `no-console` as `warn`** (F40). Clean the 25 benign warnings later, then add `--max-warnings 0`.
4. **Standardize on `vi.spyOn`** + lint-ban vscode-export reassignment (F63 slice).

### Phase 2 — Seams (make the god objects injectable _before_ splitting)

Order matters — these are the "add a seam" refactors the splits depend on:

1. **Static `create()` factories** replacing async-constructor casts (F13) — cleanest DI entry point for SCM and Repository; preserve LateInit/Async.
2. **Role interfaces for the orchestration services** (F11) + **type the repo-lookup seam** (F58) + **`BlameProvider` constructor injection** (F08). Add `dependency-cruiser`/eslint `import/no-cycle` so boundaries can't silently erode.
3. **`Resource.withLock()` copy-helper** (F54) — also fixes the latent propertyChanges-drop bug.
4. Larger seam work — **SCM injection into base `Command`** (F12) and **`RepositoryDependencies` + `create()`** (F31) — are `large`; schedule deliberately, they ripple to ~70 subclasses.

### Phase 3 — Decomposition (large; each behind characterization tests)

Within each god object, **lift pure slices first, stateful/lifecycle slices last:**

1. **`refresh()` reconcile** (F09) — extend the branch-pinning test first, then `pageMore`/`pruneAutoRepos` (safe commit), then pure `reconcileCache` (separate commit). Follow with the **vestigial multi-repo cache collapse** (F10) and the **filter-wizard extraction** (F51) in the same subsystem.
2. **`blameProvider` split** (F24) — colorizer/SVG/formatting first, `BlameCache` (F50) last; the **triplicated decoration loop** (F07) folds in naturally.
3. **`sparseCheckoutProvider` split** (F27) — write characterization tests first (it's currently untested); the `TtlCache` (F35) and monitor extraction (already done in Phase 0) feed it.
4. **`command.ts` base split** (F23) via delegating wrappers; **route commands through `handleOperationError`** (F06, starting with single-op `setDepth`).
5. **`run()`/`retryRun()` `OperationRunner`** (F18), **property/lock cache service** (F19), **`executeProcess` split** (F46) — the riskiest; characterization tests around ordering/mutex/cache-coherence are mandatory.
6. **`BaseLogProvider`** (F25) once both log providers stop churning.

### Deprioritize / do opportunistically

`src/` folder reorg (F66), file-naming normalization (F15), the `common/types.ts`/`util.ts` split (F29), the delegation-wrapper/exec-core/cache-primitive megarefactors (F20/F21/F22), and the two-tree-paradigm unification (F28) are `large` with `low`-to-`medium` corrected impact and real churn/regression risk. Fold their _safe slices_ (typed action ids in F49, `runXml` in F21, `RepoRootNode<T>` in F28) into adjacent work rather than tackling them head-on. Leave the build toolchain (F16) and `c8` alone.

**Net:** Phases 0-1 are a few days of mostly-confirmed, low-risk work that fix the one real user-facing bug and stop the decay. Phase 2 is the pivot — once seams exist, the god-object splits in Phase 3 become tractable and testable instead of terrifying. Resist starting Phase 3 before Phase 2; the review's own `plausible` verdicts are almost entirely "the code has no safety net for this yet."
