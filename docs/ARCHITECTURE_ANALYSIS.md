# SVN Extension Architecture

**Version**: 0.2.92
**Updated**: 2026-07-12

---

## Overview

VS Code extension for SVN source control with Positron IDE support. Event-driven architecture, decorator-based commands, multi-repository management. Zero telemetry, local-only operations.

**Stats**:

- ~34,300 source lines (non-test src/\*_/_.ts)
- 104 contributed commands, 80 settings
- 2082 tests
- Targets: vscode ^1.109.0, positron ^2026.04.0

---

## Architecture Layers

```
┌─────────────────────────────────────────────────┐
│  Extension Entry (extension.ts)                 │
│  activate() → SvnFinder → Svn → SCM Manager     │
├─────────────────────────────────────────────────┤
│  Source Control Manager                         │
│  Multi-repo coordination, workspace detection   │
├─────────────────────────────────────────────────┤
│  Repository Layer                               │
│  - Repository: Single repo state & coordination │
│  - Services: Status, ResourceGroup, Remote      │
├─────────────────────────────────────────────────┤
│  SVN Execution (svn.ts)                         │
│  Process spawn, encoding, auth management       │
├─────────────────────────────────────────────────┤
│  Command Pattern (command.ts + ~72 subclasses)  │
│  Repository resolution, diff/show infrastructure│
└─────────────────────────────────────────────────┘
```

### Key Files

| Layer    | Files                                                             |
| -------- | ----------------------------------------------------------------- |
| Entry    | extension.ts, source_control_manager.ts                           |
| Core     | repository.ts, svnRepository.ts, svn.ts                           |
| Services | StatusService.ts, ResourceGroupManager.ts, RemoteChangeService.ts |
| Commands | command.ts (base), commands/\*.ts (73 files)                      |
| Parsing  | statusParser.ts, logParser.ts, infoParser.ts, blameParser.ts      |
| Blame    | blameConfiguration.ts, blameStateManager.ts, blameProvider.ts     |

---

## Design Patterns

1. **Command Pattern**: Base class + ~72 subclasses with DRY helpers
2. **Observer/Event**: EventEmitter throughout for loose coupling
3. **Decorator**: @memoize, @throttle, @debounce, @sequentialize
4. **Strategy**: Multiple parsers (status, log, info, diff, list)
5. **Adapter**: XML parser abstraction, file watching, URI schemes
6. **Repository**: Data access abstraction per repo

---

## Key Subsystems

### Blame System

Per-file blame tracking with:

- Progressive rendering (10-20x faster)
- Template compilation for status bar/gutter
- Batch log fetching (50x faster), targeted at the blamed file
- LRU cache eviction (MAX_CACHE_SIZE=20)
- Shared provider resolves deepest repo ownership per URI; owner generations,
  document versions, per-editor render generations, liveness, and current
  settings fence async writes/applies; delayed edit cleanup retains its owner
- Visible split editors reconcile losslessly on repo open/close/status,
  mutations, saves, state changes, and configuration changes; work coalesces
  within a repo while separate repos repaint concurrently
- Cross-WC invalidation carries targets and traversal scope, unions best-effort
  pre/post external topology, then follows exact external-root → opened-WC-root
  edges; file batches skip topology probes and large target sets use one
  recursive read, then complete 16-path recovery batches if needed; failed
  batches isolate targets, await siblings, and preserve partial roots across
  one lock retry, independently of normal UI status
- Scoped message LRU invalidates only render entries that depend on the changed
  repo+revision; in-flight add-revision and message fetches are deduplicated
- Line mapping strips equal edges, then uses bounded dense LCS, dense-compatible
  linear-space LCS, a bounded exact low-edit band with checkpointed traceback,
  budget-derived exact match-sparse LCS, and non-crossing anchors for ambiguous
  cores; an empty exact sparse LCS remains proof, so bracketed total rewrites
  retain attribution without quadratic gaps
- Status-bar teardown fences deferred repository readiness and cancels pending
  debounce work before disposing UI resources; async results revalidate the
  newest generation, active editor, and line. Blame uses descendant ownership
  so status exclusions cannot hide svn:externals
- autoBlame-gated auto-fetch; CSV/large-file gates on all fetch paths
  (render, cursor, status bar)

### File Locking (v0.1.0+)

- Commands: lock, unlock, breakLock
- Lock status in tooltips and decorations
- Directory support

### Sparse Checkout (v0.1.0+)

- TreeView in SCM sidebar
- Lazy-loads children via `svn list`
- Depth options: empty, files, immediates, infinity

### Git-like Staging

- Hidden `__staged__` changelist
- Optimistic UI updates (skip status refresh)
- ResourceGroupManager handles group manipulation
- `stageOptimistic(files, { expand })` — single entry point; `expand` opt-in for directory expansion
- `unstageOptimistic` accepts grouped `Map<string|null, string[]>` for batched multi-changelist restore (one UI notify regardless of destination count)
- `notifyStagingChanged()` private centralises action-button refresh + input-box revalidation

---

## Services (Extracted from Repository)

| Service              | Purpose                                    | Lines |
| -------------------- | ------------------------------------------ | ----- |
| StatusService        | Parse SVN status, update model             | ~355  |
| ResourceGroupManager | Manage VS Code resource groups             | ~298  |
| RemoteChangeService  | Background polling timers                  | ~107  |
| CommitFlowService    | Staging & commit orchestration             | ~300  |
| SvnAuthCache         | Credential storage (keyring/SecretStorage) | ~200  |

---

## Performance

All critical bottlenecks fixed:

- **Commit traversal**: O(1) parent lookups, 4-5x faster
- **Descendant resolution**: Single-pass O(n), 3-5x faster
- **Glob matching**: Two-tier simple→complex, 3x faster
- **Batch operations**: Adaptive chunking, 2-3x faster
- **Startup**: Conditional activation + path caching, 1-3s saved
- **Commit workflow**: Cached remote-check, parallel needs-lock, deduplicated history fetches — fewer network round-trips per commit

Caching strategy:

- LRU eviction for info, blame, log caches
- Blame: lock-free warm reads require a resolved numeric BASE key and are
  guarded by mutation state; info, persistent-key namespace, BASE-key,
  negative-cache, and blame writes share generation fences that start before
  async key resolution; repository disposal aborts reads, status retries, and
  post-operation topology
- Immutable data (SVN logs) = infinite TTL
- Remote-check result cached with poll-frequency TTL for pre-commit reuse

---

## Security

- Password via stdin (SVN 1.10+)
- XXE protection in XML parser
- Error sanitization (logError utility)
- Zero telemetry, local-only operations
- Debug mode auto-timeout

See [SECURITY.md](../.github/SECURITY.md) for details.

---

## Build & Deploy

```bash
npm run compile    # esbuild + sass
npm run watch      # Watch mode
npm test           # Vitest unit tests
npm run package    # VSCE package
```

Output: dist/extension.js (CJS, minified)
External: vscode, @posit-dev/positron

---

## Strengths

1. Clean separation of concerns (services extracted)
2. Type-safe (strict TypeScript, minimal `any`)
3. Performance optimized (all P0/P1 fixed)
4. Comprehensive testing (930+ tests)
5. Security hardened (sanitization, stdin passwords)
6. Multi-repo support (independent operation queues)

---

## Test Harness Notes

- Vitest runs mixed legacy/new suites through a Mocha-compat setup file.
- Harness now depends on:
  - command registry behavior in the VS Code mock (`registerCommand` + `executeCommand`)
  - `thisArg` binding support in command registration
  - default-backed configuration reads for `workspace.getConfiguration("sven").get(...)`
  - workspace lifecycle event mocks (`onDidSaveTextDocument`, `onDidCloseTextDocument`, etc.)
  - `workspace.textDocuments` tracking for code paths that inspect open documents
  - ESM-safe mocking style in tests (`vi.spyOn` instead of export reassignment)
  - parser fixture parity with adapter defaults (`explicitRoot: false` root-stripped outputs)
  - command helper contract awareness (`runByRepositoryPaths` handles URI→path conversion)
  - suite preflight checks for required binaries and extension command registration before E2E setup
  - per-test readiness wrappers (`testIfReady` + `suiteReady`) in legacy E2E suites to prevent execution with uninitialized fixtures when preflight fails
  - explicit stable test file allowlist in `.vscode-test.mjs` for CI-hosted VS Code runs
  - cross-platform path assertions based on invariant suffixes, not runner-specific home directory prefixes
  - signal-based timer assertions (promise+timeout) for polling tests instead of fixed sleeps
  - teardown settle window before temp-repo deletion for suites with background poll/status tasks
  - suites unrelated to remote polling disable it before opening temporary repositories

---

## Technical Debt

- Repository.ts still ~2980 lines (auth + property-cache blocks extractable)
- 73 command files in src/commands/ (incl. base) after consolidation (reveal, ignore, patch, commit merged)
- ~248 `any` types remaining across 25 files (mostly test files; production ~5 files)
- fs/ wrappers use `promisify(original-fs)` — could use `original-fs.promises`

A standalone architecture & maintainability review lives in
[MAINTAINABILITY_REVIEW.md](MAINTAINABILITY_REVIEW.md) (65 verified findings,
phased plan). Phase 0 (quick wins) complete as of 0.2.70: dead `AuthService`
fork deleted, orphaned watch commands removed, `pLimit`/download monitors
extracted, dependency/manifest hygiene. Phase 1 (foundations) complete as of
0.2.71: `SvnError extends Error` + svn-aware `getErrorMessage` (fixes the
"Unknown error" bug), shared `classifyBlameError`, async-safety lint promoted
to errors. Deferred within Phase 1: the F63 `vi.spyOn` test-harness migration
(large; entangled with the eslint-ignored `src/test/**`). Phase 2 (seams)
partial as of 0.2.72: `Resource.withLock()` (fixes the F54 propertyChanges-drop
bug), role interfaces for the commit services (F11). Deferred to a dedicated
construction/DI pass. **F13 done as of 0.2.73**: `static create()` factories
replace the async-constructor cast; `ConstructorPolicy` removed.

Still deferred — **F31** (god-object `Repository` DI): its constructor is
synchronous but hard-wires VS Code globals (`scm.createSourceControl`,
`window.registerFileDecorationProvider`, window focus) and is `this`-coupled
(`new StatusBarCommands(this)`, `new SvnFileDecorationProvider(this)`).
Unit-constructibility requires injecting those _boundary_ operations via a
`RepositoryDependencies` struct (real defaults), and per the review that must
follow a construction characterization-test suite (none exists — tests use
`Partial<Repository>`). Large; its own session.

**Triage update (0.2.74)**: a second pass re-verified all deferred findings
against current code and executed the worth-it subset (F19-rescoped, F10, F52,
F06-slice, F07, F35, real retryRun tests, lint ratchet with
`--max-warnings 0`). ~75% of the backlog was dropped with reasons — F12 is a
non-issue in practice, F50 would reintroduce a fixed flake, F31/F18 stay
parked as a pair. See MAINTAINABILITY_REVIEW.md §5. F17 landed in 0.2.75
(test dirs now lint- and type-gated via tsconfig.test.json + pretest);
the review backlog is fully closed.

---

See also:

- [LESSONS_LEARNED.md](LESSONS_LEARNED.md) - Development patterns
- [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) - UI/UX conventions
- [PERFORMANCE.md](PERFORMANCE.md) - Optimization details
- [BLAME_SYSTEM.md](BLAME_SYSTEM.md) - Blame feature details
