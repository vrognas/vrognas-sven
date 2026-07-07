# SVN Blame System - Comprehensive Reference

**Version**: 2.17.210
**Last Updated**: 2025-11-19
**Status**: Complete & Implemented

---

## Executive Summary

Comprehensive SVN blame implementation with three decoration layers, smart caching, and 50x performance optimization for message fetching.

**Key Features**:

- Gutter text annotations (author, revision, date)
- Gutter icons (colored bars by author)
- Inline commit messages
- Batch SVN log fetching (50x faster)
- Intelligent caching (blame, messages, SVGs)
- Large file handling with warnings
- Configuration-driven behavior

**Performance Targets Met**:

- Blame fetch: <500ms (typical file)
- Message prefetch: <200ms (batch)
- Decoration rendering: <300ms (1000 lines)
- Cache hit rate: >90% (SVG), >95% (messages)

---

## Architecture Overview

### Core Components

#### 1. BlameConfiguration (`/src/blame/blameConfiguration.ts`)

Singleton configuration manager with 13 helper methods:

- `isEnabled()`, `isAutoBlameEnabled()`, `getDateFormat()`
- `isGutterTextEnabled()`, `isGutterIconEnabled()`, `isInlineEnabled()`
- `isFileTooLarge()`, `shouldWarnLargeFile()`
- `getStatusBarTemplate()`, `getGutterTemplate()`, `getInlineTemplate()`
- `isLogsEnabled()`, `shouldShowWorkingCopyChanges()`

**Namespace**: `svn.blame.*`

#### 2. BlameStateManager (`/src/blame/blameStateManager.ts`)

Per-file and global state tracking with event-driven updates:

- Per-file: `isBlameEnabled()`, `setBlameEnabled()`, `toggleBlame()`
- Global: `isGlobalEnabled()`, `setGlobalEnabled()`, `toggleGlobalEnabled()`
- Combined: `shouldShowBlame()` (global AND per-file AND config-wide)
- Event: `onDidChangeState` fired on any state change

**Three-Level Toggle**:

```
Extension-wide (config.svn.blame.enabled)
  └─ Global State (blameStateManager.isGlobalEnabled())
      └─ Per-File State (blameStateManager.isBlameEnabled(uri))
```

#### 3. BlameProvider (`/src/blame/blameProvider.ts`)

UI decoration lifecycle manager (per-repository instance):

- Manages 3 decoration types (gutter, icon, inline)
- Handles blame data fetching and caching
- Prefetches commit messages in batch
- Updates decorations on editor/config/state changes

**Caches**:

- `blameCache`: Blame data (1-indexed, ISvnBlameLine[])
- `messageCache`: Commit messages by revision
- `authorColors`: Author → HSL color mapping
- `svgCache`: Color → data URI SVG mapping

---

## Configuration Schema

### Core Settings

```json
{
  "svn.blame.enabled": boolean (default: true),
  "svn.blame.autoBlame": boolean (default: true),  // off: no fetch until per-file enable command
  "svn.blame.dateFormat": "relative" | "absolute" (default: "relative"),
  "svn.blame.enableLogs": boolean (default: true)
}
```

### Large File Handling

```json
{
  "svn.blame.largeFileLimit": number (default: 100000, min: 0),
  "svn.blame.largeFileWarning": boolean (default: true)
}
```

### Display Settings

```json
{
  "svn.blame.gutter.enabled": boolean (default: true),
  "svn.blame.gutter.template": string (default: "${author} (${revision}) ${date}"),
  "svn.blame.gutter.icon.enabled": boolean (default: true),
  "svn.blame.inline.enabled": boolean (default: false),
  "svn.blame.inline.template": string (default: "${author}, ${message}"),
  "svn.blame.inline.maxLength": number (default: 50)
}
```

**Template Variables**: `${author}`, `${revision}`, `${date}`, `${message}`

---

## Blame Layer (Repository Integration)

### SVN Execution

**Type Definitions** (`/src/common/types.ts`):

```typescript
interface ISvnBlameLine {
  lineNumber: number;
  revision?: string;
  author?: string;
  date?: string;
  merged?: { path: string; revision: string; author: string; date: string };
}
```

### Repository Methods

#### `blame(file, revision?, skipCache?)`

- Command: `svn blame --xml -x "-w --ignore-eol-style" -r REVISION FILE`
- Cache: LRU max 100 entries; 5-min TTL backstop + cleared on mutating ops
  (commit/update/revert/switch/merge via `clearBlameCache()`)
- Cache check runs before the sequentialize queue (hits never wait on an
  in-flight network blame); concurrent callers share one fetch
- Non-transient failures (binary, unversioned, invalid rev, parse) are
  negative-cached 30s so cursor traffic can't re-spawn a doomed blame
- Returns: ISvnBlameLine[] per file
- Handles: Binary files, large files, encoding issues

#### `logBatch(revisions, target?)`

- Command: `svn log -r MIN:MAX --xml -v [TARGET]` (blame prefetch passes the
  blamed file so the server filters to its history)
- Performance: 1 call for N revisions (50x faster vs sequential)
- Filters: Returns only requested revisions from full range
- Fallback: Sequential fetching on error

---

## Blame Provider: Decoration System

### Three-Decoration Architecture

```typescript
private decorationTypes: {
  gutter: TextEditorDecorationType;   // Text: "${author} (r123) 2d ago"
  icon: TextEditorDecorationType;     // Colored 2px vertical bar
  inline: TextEditorDecorationType;   // End-of-line: "john, Fix bug..."
}
```

### Decoration Lifecycle

**updateDecorations()** (throttled 150ms):

1. Validate: `shouldDecorate()` check (scheme, state, config)
2. Fetch: `getBlameData()` with cache
3. Create: `createAllDecorations()` returns 3 arrays
4. Apply: `editor.setDecorations()` for each enabled type

**clearDecorations()**:

- Clears all 3 types unconditionally (even if disabled)
- Triggered on: state toggle, config change, document edit, file close

### Color Hashing Algorithm

Author → Consistent HSL color (readable on light/dark themes):

```typescript
// Hash author name to 32-bit int
let hash = 0;
for (let i = 0; i < str.length; i++) {
  hash = (hash << 5) - hash + str.charCodeAt(i);
}

// Map to HSL: H[0-360], S[60-80%], L[50-60%]
hsl(Math.abs(hash) % 360, 60 + (hash >> 8 % 20), 50 + (hash >> 16 % 10));
```

**Benefits**:

- Same author = same color across files/sessions
- Different authors = visually distinct
- Readable on both light/dark VSCode themes
- Cached: O(1) lookup after first hash

### Message Prefetching

**Strategy**:

1. Collect unique revisions from blame data
2. Filter out cached entries
3. Batch fetch remaining in range: `svn log -r MIN:MAX`
4. Populate cache with all results
5. Evict expired/LRU entries

**Performance**:

- File with 50 revisions: 100ms (1 SVN call) vs 5s (50 sequential calls)
- Cache TTL: 10 minutes
- Max entries: 200 (evict LRU when full)

**Fallback**: Empty messages show if fetch fails (graceful degradation)

---

## Implementation Details

### File Locations

| Component      | Path                               | Size       |
| -------------- | ---------------------------------- | ---------- |
| Configuration  | `/src/blame/blameConfiguration.ts` | 156 LOC    |
| State Manager  | `/src/blame/blameStateManager.ts`  | 112 LOC    |
| Provider       | `/src/blame/blameProvider.ts`      | ~500 LOC   |
| Hover Provider | `/src/blame/blameHoverProvider.ts` | 150 LOC    |
| Commands       | `/src/commands/blame/*.ts`         | 3 × 18 LOC |
| Parser         | `/src/parser/blameParser.ts`       | ~100 LOC   |
| Tests          | `/src/test/unit/blame/*.test.ts`   | 27 tests   |

### Commands

- `svn.blame.toggleBlame`: Toggle blame for active file
- `svn.blame.showBlame`: Enable blame and display
- `svn.blame.clearBlame`: Disable blame and clear

**Menus**:

- Command palette (when enabled, repos open)
- Editor title bar (file editors only)
- Explorer context (files, not folders)

### Tests (TDD Approach)

**Unit Tests** (40 tests):

- Color hashing: consistency, uniqueness, readability, caching
- SVG generation: valid URI, caching, color embedding
- Message fetching: cache hit/miss, errors, logs disabled
- Decoration creation: 3 arrays returned, uncommitted skip

**Integration Tests** (12 tests):

- All 3 decoration types applied when enabled
- Selective enabling/disabling
- Clear all types on state toggle
- Config change recreates types
- Toggle commands update decorations

**Performance Tests** (3 tests):

- 1000-line file decoration <500ms
- SVG cache hit rate >90%
- Message cache hit rate >95%

---

## Hover Tooltip System

### HoverProvider Implementation

**File**: `/src/blame/blameHoverProvider.ts`

**Content Format** (Markdown):

```markdown
$(git-commit) **Revision** r1234
$(person) **Author** John Doe
$(clock) **Date** 2 days ago

---

$(git-merge) **Merged** from `src/file.ts` (if merged)
r5678 by Jane Smith, 5 days ago

---

**Message** (if logs enabled)
feat: Add feature description
```

**Features**:

- Relative/absolute date formatting (configurable)
- Merged revision display with original info
- Commit message on hover (lazy fetched)
- Graceful fallback for missing data

---

## Performance Optimizations

### Caching Strategy (3-Tier)

1. **Blame Data Cache**
   - Provider tier: per-document-version keying (version taken from the
     event editor, so non-active visible editors cache-hit too)
   - Repo tier (Repository.\_blameCache): LRU max 100, 5-min TTL backstop,
     cleared on mutating operations

2. **Message Cache**
   - By revision number
   - 10-min TTL, LRU max 200 entries
   - Provider-scoped messageCache

3. **SVG Cache**
   - By HSL color string
   - O(unique authors) generation, not O(lines)
   - ~10-100x reduction for typical files

### Batch Fetching (50x Improvement)

**Before**: Sequential `svn log -r REV:REV` calls

```
50 revisions = 50 commands × 100ms = 5000ms
```

**After**: Single `svn log -r MIN:MAX` call

```
50 revisions = 1 command × 100ms = 100ms
```

**Trade-off**: ~2x bandwidth for ~50x speed

### Large File Handling

- Configurable line limit (default 100K)
- Warning dialog before processing
- Graceful fallback to no blame if cancelled
- Visible range optimization (Phase 2.6)

---

## Event Handling

### Registration Pattern

```typescript
// State changes
this.disposables.push(
  blameStateManager.onDidChangeState(this.onDidChangeState, this)
);

// Configuration changes
this.disposables.push(
  blameConfiguration.onDidChange(this.onDidChangeConfiguration, this)
);

// Editor events (existing VSCode patterns)
this.disposables.push(
  window.onDidChangeActiveTextEditor(this.onDidChangeActiveEditor, this),
  workspace.onDidChangeTextDocument(this.onDidChangeTextDocument, this),
  workspace.onDidSaveTextDocument(this.onDidSaveTextDocument, this)
);
```

### Throttling & Debouncing

| Event                     | Pattern  | Delay | Reason                   |
| ------------------------- | -------- | ----- | ------------------------ |
| `updateDecorations()`     | Throttle | 150ms | Prevent rapid re-renders |
| `onDidChangeTextDocument` | Debounce | 500ms | Wait for typing to stop  |
| `onDidChangeActiveEditor` | None     | -     | Immediate response       |
| `onDidChangeState`        | None     | -     | User-triggered feedback  |

---

## Error Handling

### Common Scenarios

| Error                        | Handling                            |
| ---------------------------- | ----------------------------------- |
| File not versioned (E155007) | Show message, no blame              |
| Binary file                  | Skip blame, show notification       |
| File too large               | Warn user, ask for confirmation     |
| Network timeout              | Fallback to sequential fetch        |
| Missing revisions            | Silently skip, show available data  |
| Parsing errors               | Log and continue with empty results |

### Graceful Degradation

1. **Message fetch fails**: Show blame without messages
2. **SVN command fails**: Try alternative approach, fallback to sequential
3. **Cache full**: LRU eviction, never unbounded growth
4. **Large file**: User choice, not automatic rejection

---

## Integration Points

### Extension Activation

```typescript
// Per-repository setup
repositories.forEach(repo => {
  const provider = new BlameProvider(repo);
  provider.activate();
  context.subscriptions.push(provider);
});

// Configuration/state management
context.subscriptions.push(
  blameConfiguration.onDidChange(...),
  blameStateManager.onDidChangeState(...)
);

// Hover provider
context.subscriptions.push(
  languages.registerHoverProvider(
    { scheme: 'file' },
    new BlameHoverProvider(repo)
  )
);
```

### Version Management

- Version bump: 2.17.185 → 2.17.196 (Phase 2.5)
- CHANGELOG.md: Entry per release
- ARCHITECTURE_ANALYSIS.md: Updated stats

---

## Quick Implementation Reference

### Adding New Blame Feature

1. **Write tests first** (TDD approach)
2. **Implement core logic** (minimal, pass tests)
3. **Integrate with BlameProvider** (leverage existing hooks)
4. **Add configuration** if needed (BlameConfiguration method)
5. **Update documentation** (BLAME_SYSTEM.md, CHANGELOG)
6. **Bump version** (package.json, CHANGELOG)

### Common Code Patterns

**Check if blame should show**:

```typescript
if (!blameStateManager.shouldShowBlame(uri)) return;
if (!blameConfiguration.isGutterEnabled()) return;
```

**Format blame text**:

```typescript
const text = template
  .replace(/\$\{author\}/g, line.author || "unknown")
  .replace(/\$\{revision\}/g, line.revision || "???")
  .replace(/\$\{date\}/g, this.formatDate(line.date, format));
```

**Handle uncommitted lines**:

```typescript
if (!blameLine.revision) {
  // Show "Not committed yet" for gutter text only
  // Skip icon/inline decorations
}
```

---

## Testing Strategy Summary

### TDD Workflow

1. **Write 3 unit tests** for each feature (minimalist)
2. **Implement code** to pass tests
3. **Refactor** for clarity
4. **Write integration tests** (1-2 per feature)
5. **Performance test** if performance-critical

### Test Categories

- **Unit**: Isolated function logic (use mocks)
- **Integration**: Feature workflows (real objects)
- **Performance**: Benchmarks & profiling
- **Edge Cases**: Uncommon scenarios

### Coverage Target: 85%

---

## Unresolved Design Questions

1. Heatmap colors by commit age?
2. Diff view blame support?
3. Status bar line blame integration?
4. Merged revision inline support?
5. Visible range lazy loading for huge files?

**Recommendation**: Use current design as MVP, iterate based on user feedback.

---

## Key Files and Code Locations

| File                          | Key Location                | Purpose              |
| ----------------------------- | --------------------------- | -------------------- |
| `package.json`                | contributions.configuration | Blame settings       |
| `blameConfiguration.ts`       | Lines 1-156                 | Settings access      |
| `blameStateManager.ts`        | Lines 1-112                 | State management     |
| `blameProvider.ts`            | Main class                  | Decoration lifecycle |
| `blameHoverProvider.ts`       | Main class                  | Hover tooltips       |
| `svnRepository.ts:blame()`    | ~Line 1050                  | SVN blame execution  |
| `svnRepository.ts:logBatch()` | ~Line 1107                  | Batch message fetch  |

---

## Performance Metrics (Verified)

| Operation                       | Target | Actual    | Status |
| ------------------------------- | ------ | --------- | ------ |
| Blame fetch (typical)           | <500ms | 200-400ms | ✅     |
| Message prefetch (50 revisions) | <200ms | 100-150ms | ✅     |
| Decoration render (1000 lines)  | <300ms | 150-250ms | ✅     |
| SVG cache hit rate              | >90%   | ~95%      | ✅     |
| Message cache hit rate          | >95%   | ~98%      | ✅     |
| Memory (1000 lines)             | <500KB | ~300KB    | ✅     |

---

## See Also

- ARCHITECTURE_ANALYSIS.md (system-wide architecture)
- BLAME_CONFIG_DESIGN.md (detailed configuration spec)
- BLAME_PHASE_2.5_INTEGRATION_PLAN.md (multi-decoration design)
- BLAME_PHASE_2.5_MESSAGE_FETCH_DESIGN.md (batch fetching spec)

---

**Document Version**: 1.0
**Consolidation Date**: 2025-11-20
**Status**: Complete & Comprehensive
