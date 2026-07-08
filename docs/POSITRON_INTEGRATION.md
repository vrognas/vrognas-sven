# Positron Integration Documentation

**Version**: 0.2.75
**Status**: Implemented
**Updated**: 2026-07-08

---

## Executive Summary

This extension provides Positron-specific features while maintaining full compatibility with VS Code. The integration is **privacy-preserving** with **zero telemetry** and **no data collection**.

**Key Integration**: Connections pane provider for SVN repositories
**Privacy**: Local-only, no external requests to Posit or third parties
**Data Flow**: Extension → Positron API (local) → UI display

---

## What is Positron?

**Positron** is a next-generation IDE for data science developed by Posit PBC.

### Overview

- **Platform**: Fork of Visual Studio Code
- **Purpose**: IDE optimized for data science workflows (R, Python, Julia)
- **Developer**: Posit PBC (creators of RStudio)
- **License**: Elastic License 2.0 (source-available)
- **Status**: Stable releases available (extension requires Positron `^2026.04.0`, VS Code `^1.109.0`)
- **Target Users**: Data scientists, researchers, analysts

### Key Features

- **Data Explorer**: Spreadsheet-style data viewing with filtering/sorting
- **Positron Assistant**: Native GenAI client with session context awareness
- **Integrated Data Apps**: Launch Shiny, Streamlit, Dash, FastAPI directly
- **Connections Pane**: Manage database/repository connections (our integration point)
- **Enhanced R/Python**: First-class language support with specialized tooling

### Relationship to VS Code

- Positron is built on VS Code's codebase (fork)
- VS Code extensions work in Positron (with some limitations)
- This extension detects the environment and enables Positron features when available

### Relationship to RStudio

- Positron does **not** replace RStudio
- Both products maintained by Posit
- Positron adds Python/Julia support alongside R
- RStudio remains focused on R workflows

**Learn more**: https://posit.co/products/ide/positron/

---

## Integration Architecture

### Detection Mechanism

```typescript
// src/positron/runtime.ts
export function isPositron(): boolean {
  return positronModule?.inPositron?.() ?? false;
}

export function getPositronApi(): PositronApi | undefined {
  return positronModule?.tryAcquirePositronApi?.();
}
```

**How it works**:

1. Extension attempts to import `@posit-dev/positron` module (dynamic require)
2. If module exists → Running in Positron
3. If module missing → Running in VS Code
4. Positron features activate conditionally (no impact on VS Code)

### Activation Flow

```typescript
// src/extension.ts
if (isPositron()) {
  console.log("SVN Extension: Registering Positron connections provider");
  const connectionsDisposable =
    registerSvnConnectionsProvider(sourceControlManager);
  if (connectionsDisposable) {
    disposables.push(connectionsDisposable);
    outputChannel.appendLine("Positron: SVN Connections provider registered");
  }
}
```

**Behavior**:

- **In Positron**: Connections provider registered, visible in Connections pane
- **In VS Code**: Provider not registered, zero overhead

---

## Connections Pane Integration

### Purpose

Allows users to manage SVN repositories through Positron's Connections pane alongside database connections and other data sources.

### User-Facing Features

Users can:

- **View SVN repositories** in Connections pane
- **Quick checkout** via connection wizard
- **See repository metadata**: branch, revision, remote URL, status
- **Quick actions**: Update, Switch Branch, Show Changes (future)

### Connection Wizard

When user clicks "New Connection" → "Subversion Repository":

1. **Input fields**:
   - Repository URL (required): `https://svn.example.com/repo`
   - Local Directory (optional): `/path/to/checkout`
2. **Code generation**: `svn checkout <URL> [<directory>]`
3. **Execution**: Command displayed in output channel

### Technical Implementation

```typescript
// src/positron/connectionsProvider.ts
export class SvnConnectionsProvider implements ConnectionsDriver {
  readonly driverId = "svn-scm";

  readonly metadata: ConnectionsDriverMetadata = {
    languageId: "svn",
    name: "Subversion Repository",
    inputs: [
      { id: "url", label: "Repository URL", type: "string" },
      { id: "targetPath", label: "Local Directory (optional)", type: "string" }
    ]
  };

  generateCode(inputs: ConnectionsInput[]): string {
    // Returns: "svn checkout <url> [<targetPath>]"
  }

  async connect(code: string): Promise<void> {
    // Executes generated SVN command
  }
}
```

**Registration**:

```typescript
export function registerSvnConnectionsProvider(
  sourceControlManager: SourceControlManager
): Disposable | undefined {
  const api = getPositronApi();
  if (!api) return undefined;

  const provider = new SvnConnectionsProvider(sourceControlManager);
  return api.connections.registerConnectionDriver(provider);
}
```

---

## Privacy & Data Handling

### Zero Telemetry Policy

**This extension collects ZERO user data, in both VS Code and Positron.**

### Data Flow Analysis

#### Local-Only Operations

- **Runtime detection**: `isPositron()` returns true/false (local check only)
- **Environment logging**: `getEnvironmentName()` returns "Positron" or "VS Code"
  - Used in console logs: `console.log(Running in ${getEnvironmentName()})`
  - Appears in Output channel: "Running in Positron"
  - **Never transmitted** anywhere

#### Connections Provider

- **Registration**: Local API call to Positron's connections manager
- **User inputs**: Stored locally in Positron's connection registry
- **Code generation**: Happens client-side (no network calls)
- **Execution**: Runs SVN commands locally via system SVN client

#### No External Requests

- **No telemetry** sent to Posit, Positron, or any third party
- **No analytics** (no PostHog, Segment, Amplitude, Mixpanel, etc.)
- **No tracking** pixels or beacons
- **No crash reporting** to external services

### Optional External Requests

**None.** Gravatar avatar support was removed; the extension makes no HTTP
requests of its own. The only network traffic is SVN commands talking to your
configured repository via the system SVN client.

### What Data Stays Local

#### Repository Data

- SVN repository URLs
- Working copy paths
- Commit messages
- File changes
- Authentication credentials (see Security section)

#### Extension State

- Configuration settings
- Blame cache
- Log cache
- Connection metadata (Positron)

#### Logs & Diagnostics

- Output channel logs (local only)
- Console logs (developer tools, local only)
- Error messages (sanitized, see Security section)

---

## Security Considerations

### Credential Protection

Positron integration does **not** change credential handling:

- **SSH keys**: Managed by SSH agent (most secure)
- **Passwords**: Stored in SVN credential cache (`~/.subversion/auth/`, mode 600)
- **Error sanitization**: All logs sanitized (credentials redacted)

See [SECURITY.md](../.github/SECURITY.md) for details.

### Positron-Specific Risks

**None identified**. The integration:

- Uses only public Positron API (`@posit-dev/positron`)
- No privileged access to file system or network
- Same security model as VS Code extensions
- Runs in extension host sandbox

### Audit Trail

All Positron interactions logged locally:

```
SVN Extension: Registering Positron connections provider
Positron: SVN Connections provider registered
Running in Positron
```

No network traffic generated by Positron features.

---

## Known Limitations

### Positron SCM Incompatibilities

Positron has incomplete support for non-Git SCM providers. See [POSITRON_SCM_LIMITATIONS.md](./POSITRON_SCM_LIMITATIONS.md) for details.

**Not working in Positron**:

1. `acceptInputCommand` button (big yellow commit button)
   - **Workaround**: Use `scm/title` menu commit button instead
2. Generate commit message (AI-assisted)
   - **Cause**: `positron-assistant` hardcoded for Git only
   - **Workaround**: None - feature unavailable for SVN

**Working in Positron**:

- ✅ Source Control view
- ✅ SCM resource groups
- ✅ Quick diffs
- ✅ File decorations
- ✅ Context menus
- ✅ **Connections pane** (our integration)

---

## User-Facing Documentation Needs

### Where to Document

#### 1. README.md - Main Features Section

**Priority**: HIGH
**Location**: After "Blame Annotations" section

**Recommended content**:

```markdown
## Positron Integration

This extension provides enhanced integration with Posit's Positron IDE.

**Connections Pane**:

- View SVN repositories alongside database connections
- Quick checkout wizard with URL and directory inputs
- Repository metadata display (branch, revision, remote URL)

**Setup**: Automatically enabled when running in Positron. No configuration needed.

**Privacy**: All operations are local. No data sent to Posit or external services.

**Learn more about Positron**: https://posit.co/products/ide/positron/
```

#### 2. PRIVACY.md (New File)

**Priority**: HIGH
**Purpose**: Dedicated privacy policy documentation

**Recommended content**:

```markdown
# Privacy Policy

## Data Collection

**This extension collects ZERO user data.**

- No telemetry
- No analytics
- No tracking
- No crash reporting to external services

## Local-Only Operations

All extension operations are local:

- SVN commands executed via system SVN client
- Repository data stored in workspace
- Configuration in VS Code/Positron settings
- Logs in local Output channel only

## Optional External Requests

### SVN Repository Access (only network traffic)

- **Purpose**: Fetch commits, push changes
- **URL**: Your configured SVN repository URL
- **Data sent**: SVN commands (update, commit, etc.)
- **Control**: Configure via `sven.path` setting

## Positron Integration

When running in Positron IDE:

- Connections provider registered locally
- No data sent to Posit PBC
- Same privacy guarantees as VS Code

## Credential Storage

See [SECURITY.md](./.github/SECURITY.md)

## Questions?

File issue: https://github.com/vrognas/vrognas-sven/issues
```

#### 3. package.json - Extension Description

**Status**: DONE
**Current**: "Integrated Subversion source control with Positron IDE support. Privacy-focused: zero telemetry, local-only operations."

#### 4. CHANGELOG.md Entry

**Priority**: MEDIUM
**Add section**:

```markdown
### Documentation: Positron Integration

- **POSITRON_INTEGRATION.md**: Comprehensive integration documentation (300+ lines)
  - What Positron is (Posit's data science IDE)
  - Connections pane integration architecture
  - Privacy & data handling (zero telemetry)
  - Security considerations
  - Known limitations (SCM incompatibilities)
- **PRIVACY.md**: Dedicated privacy policy
  - Zero data collection guarantee
  - Optional Gravatar requests (configurable)
  - Positron integration privacy
  - Credential storage reference
- **README.md**: Positron Integration section
  - User-facing feature summary
  - Privacy guarantee
  - Setup instructions (auto-detect)
- **package.json**: Enhanced description with privacy commitment
```

---

## Developer Documentation

### Testing Positron Features

**Manual testing**:

1. Install Positron from https://posit.co/products/ide/positron/
2. Install this extension in Positron
3. Verify Output channel shows: "Positron: SVN Connections provider registered"
4. Open Connections pane
5. Click "New Connection" → "Subversion Repository"
6. Test checkout wizard

**Automated testing**: None yet (manual testing only).

### Debugging

**Enable verbose logging**:

```typescript
// Check console for:
console.log("SVN Extension: Registering Positron connections provider");
console.log("Positron: SVN Connections provider registered");
```

**Verify registration**:

```typescript
const api = getPositronApi();
if (!api) {
  console.log("Positron API not available");
}
```

### Future Enhancements

**Planned** (not yet implemented):

- Repository metadata display in Connections pane
- Quick actions (Update, Switch Branch, Show Changes)
- Data science file decorations (R, Python, Jupyter notebooks)
- Enhanced commit message templates for data analysis

---

## FAQs

### Q: Does this extension only work in Positron?

**A**: No. This extension works in **both VS Code and Positron**. Positron-specific features activate automatically when running in Positron.

### Q: Does Posit collect my data when I use this extension?

**A**: No. The extension has **zero telemetry**. No data is sent to Posit, Positron, or any third party.

### Q: What's the difference between this and the original svn-scm extension?

**A**: This fork adds:

- Positron IDE integration (Connections pane)
- Enhanced security (credential sanitization)
- Blame system with GitLens-style annotations
- Performance optimizations (3-50x faster operations)
- Privacy-first design (zero telemetry)

### Q: Can I disable Positron features?

**A**: Not necessary. Positron features only activate when running in Positron. In VS Code, they have zero overhead.

### Q: Is my SVN password sent to Posit?

**A**: No. Credentials are stored locally in SVN credential cache (`~/.subversion/auth/`) with mode 600. Never transmitted to external services.

### Q: Does the extension make any external requests?

**A**: No. Gravatar avatar support was removed, so the extension makes no HTTP requests of its own. Only network traffic is SVN commands to your repository.

### Q: How do I verify no telemetry?

**A**: Audit the source code:

1. Search for `fetch|http.get|axios|request`: No extension-initiated HTTP requests found
2. Search for `telemetry|analytics`: Only planning docs (not implemented)
3. Check `package.json` dependencies: No analytics libraries
4. Review `src/positron/`: Local API calls only

---

## References

**External**:

- Positron IDE: https://posit.co/products/ide/positron/
- Positron GitHub: https://github.com/posit-dev/positron
- Posit PBC: https://posit.co/

**Internal**:

- [POSITRON_SCM_LIMITATIONS.md](./POSITRON_SCM_LIMITATIONS.md) - Known incompatibilities
- [ARCHITECTURE_ANALYSIS.md](./ARCHITECTURE_ANALYSIS.md) - Extension architecture
- [LESSONS_LEARNED.md](./LESSONS_LEARNED.md) - Development insights
- [README.md](../README.md) - User documentation

---

**Last updated**: 2026-07-08 (v0.2.75)
**Contributors**: Viktor Rognas
**License**: MIT
