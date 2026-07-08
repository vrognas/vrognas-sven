# Positron SCM Limitations for Non-Git Providers

**Version**: 0.2.75
**Updated**: 2026-07-08

## Overview

Positron (a fork of VS Code) has incomplete support for non-Git SCM providers. Several features that work in VS Code or are Git-specific in Positron.

---

## Confirmed Limitations

### 1. Accept Input Command Button (Big Yellow Button)

**Status**: ❌ Not Working
**Workaround**: ✅ Use scm/title menu instead

**Details**:

- The `acceptInputCommand` button that appears below the commit message input box
- In VS Code with Git: Renders automatically when `acceptInputCommand` is set
- In Positron with SVN: Does not render even when properly configured
- **Error location**: Positron's SCM UI rendering code (likely has `scmProvider == git` restriction)

**Our workaround** (v2.17.177):

```json
"scm/title": [
    {
        "command": "sven.commitAll",
        "group": "navigation",
        "when": "scmProvider == svn"
    }
]
```

### 2. Generate Commit Message

**Status**: ❌ Not Working (Git-only)
**Workaround**: ❌ None available

**Details**:

- Feature provided by Positron's `positron-assistant` extension
- Hardcoded to only work with Git repositories
- **Error thrown**: `Error: No Git repositories found`
- **Stack trace**:
  ```
  at t.generateCommitMessage (positron-assistant/dist/extension.js:2:162697)
  ```

**Impact**: Users cannot use AI-assisted commit message generation with SVN

### 3. Input Box Visibility (Unconfirmed)

**Status**: ⚠️ User reports not displaying text
**Configuration**: Should be working

**Current settings** (src/repository.ts):

```typescript
this.sourceControl.inputBox.placeholder =
  "Message here or Ctrl+Enter for guided commit";
this.setOptionalInputBoxProperty("visible", true);
this.setOptionalInputBoxProperty("enabled", true);
```

**Needs investigation**: User reported "message input window doesn't display any text"

---

## Properties Confirmed Working

✅ `sourceControl.id`
✅ `sourceControl.label`
✅ `sourceControl.rootUri`
✅ `sourceControl.contextValue`
✅ `sourceControl.count`
✅ `sourceControl.quickDiffProvider`
✅ `scmProvider` context key (for menu when clauses)

---

## VS Code vs Positron Differences

| Feature                   | VS Code  | Positron    |
| ------------------------- | -------- | ----------- |
| acceptInputCommand button | ✅ Works | ❌ Git-only |
| Generate commit message   | N/A      | ❌ Git-only |
| SCM inputBox              | ✅ Works | ⚠️ Unclear  |
| scm/title menu            | ✅ Works | ✅ Works    |
| scm/resourceGroup menu    | ✅ Works | ✅ Works    |

---

## Recommendations

1. **For Commit Button**: Use scm/title menu (implemented in v2.17.177)
2. **For AI Commit Messages**: File issue with Positron team to support non-Git SCM
3. **For Input Box**: Need more user testing to understand the issue

---

## Related Files

- `package.json` (`scm/title` menu) - Commit button workaround
- `src/repository.ts` - SourceControl initialization
- Error log shows: `positron-assistant/dist/extension.js` - Git-specific code

---

## Future Work

- File issue with Positron team about acceptInputCommand support
- Request positron-assistant to support non-Git SCM providers
- Investigate inputBox text display issue

---

**See also**: ARCHITECTURE_ANALYSIS.md, CHANGELOG.md
