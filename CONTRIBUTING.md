# Contributing to Positron-SVN

Welcome! Positron-SVN is a VS Code extension providing Subversion source control with Positron IDE integration. We follow TDD, strict TypeScript, and incremental commits.

## Quick Start

### Prerequisites

- **Node.js** 18+ and npm 9+
- **SVN** 1.6+ installed and in PATH
- **VS Code** 1.74+ or **Positron** 2025.6+
- **Git** (for source control)

### Setup

```bash
# Clone repository
git clone https://github.com/vrognas/vrognas-sven.git
cd vrognas-sven

# Install dependencies
npm install

# Build TypeScript
npm run build:ts

# Build CSS
npm run build:css

# Run tests
npm test
```

### Development Workflow

```bash
# Watch mode (auto-compile TypeScript)
npm run compile

# Watch CSS changes (separate terminal)
npm run watch:css

# Run unit tests (no coverage)
npm run test:unit

# Run with coverage report
npm run test:coverage

# Lint code
npm run lint

# Fix lint issues
npm run lint:fix
```

### Debug Extension

1. Open in VS Code/Positron
2. Press `F5` or Run > Start Debugging
3. New window opens with extension loaded
4. Set breakpoints in TypeScript source

See `.vscode/launch.json` for configurations.

## Development Guidelines

### TDD Workflow (MANDATORY)

**Before writing implementation:**

1. **Write plan**: Numbered implementation steps
2. **Write tests**: 3 end-to-end tests minimum
   - Happy path (core scenario)
   - Edge case 1
   - Edge case 2
3. **Run tests**: Verify they fail
4. **Implement**: Make tests pass
5. **Refactor**: Clean up after tests pass
6. **Run all tests**: Ensure nothing broken

**Example test structure:**

```typescript
describe("Feature Name", () => {
  it("should handle happy path", async () => {
    // Arrange: setup real SVN repo, files
    // Act: execute command
    // Assert: verify behavior
  });

  it("should handle edge case 1", async () => {
    // Real SVN operations, no mocks
  });

  it("should handle edge case 2", async () => {
    // Test error conditions
  });
});
```

**Testing principles:**

- ✅ Test behavior, not implementation
- ✅ Use real SVN/file system (no mocks)
- ✅ 3 tests per feature sufficient
- ✅ Stop at 50-60% coverage
- ❌ Don't test implementation details
- ❌ Don't overtest

### Commit Conventions

**Format:**

```
<type>: <concise description>

[optional body]
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `test`: Add/update tests
- `refactor`: Code restructure (no behavior change)
- `perf`: Performance improvement
- `docs`: Documentation only
- `chore`: Build, deps, tooling

**Rules:**

- Small, focused commits (one concern per commit)
- Version bump per commit (semantic versioning)
- 10-50 lines ideal
- Sacrifice grammar for concision
- Example: `fix: sanitize error in parseInfoXml`

**Version bumping:**

- Major (x.0.0): Breaking changes
- Minor (0.x.0): New features (backward compatible)
- Patch (0.0.x): Bug fixes, refactors

### Code Quality Standards

**TypeScript:**

- ✅ Strict mode enabled (no bypasses)
- ✅ No `any` types without justification
- ✅ Descriptive error messages
- ✅ Type guards for user input
- ❌ No `transpileOnly` mode
- ❌ No unsafe casts

**Error handling:**

```typescript
// ❌ Bad: Silent errors
catch (err) { reject(); }

// ✅ Good: Descriptive context
catch (err) {
  console.error("parseInfoXml error:", err);
  reject(new Error(`Failed to parse: ${err.message}`));
}
```

**Security:**

- All error paths must sanitize credentials/paths
- Use `logError()` utility from `util/errorLogger.ts`
- Never expose passwords in logs or error messages
- CI validates 100% sanitization coverage

**Performance:**

- Profile before optimizing
- Fix P0 bottlenecks first
- Debounce/throttle UI-triggered operations
- Use batch operations for multiple SVN calls
- LRU cache eviction for unbounded caches

### Architecture Patterns

**Services:**

- Stateless with parameter objects
- Extract from god classes incrementally
- Move decorators to caller
- 3 TDD tests before extraction

**Dependency migration:**

- Adapter pattern for old API compatibility
- Incremental rollout (simplest first)
- Comprehensive compatibility tests

**Critical paths:**

- Map failure cascades before refactoring
- Add diagnostic logging
- Test extensively

See [LESSONS_LEARNED.md](./docs/LESSONS_LEARNED.md) for detailed patterns.

## Pull Request Process

### Before Submitting

1. ✅ All tests pass (`npm test`)
2. ✅ Lint clean (`npm run lint`)
3. ✅ Coverage 50-60% maintained
4. ✅ Version bumped (package.json, CHANGELOG.md)
5. ✅ Docs updated (if public API changed)
6. ✅ LESSONS_LEARNED.md updated (if new patterns)
7. ✅ ARCHITECTURE_ANALYSIS.md updated (if structural)

### PR Template

```markdown
## Summary

Brief description of changes

## Testing

- 3 e2e tests added: [test names]
- All 930+ tests passing
- Coverage: [before]% → [after]%

## Checklist

- [ ] Tests written first (TDD)
- [ ] Lint passing
- [ ] Version bumped
- [ ] CHANGELOG.md updated
- [ ] Documentation updated (if applicable)
- [ ] No security/credential exposure

## Related Issues

Fixes #123
```

### Review Criteria

Reviewers check:

- Type safety (no unsafe casts)
- Encapsulation (no internal leaks)
- Test coverage (critical paths)
- Performance (no regressions)
- Security (sanitization)
- Commit hygiene (small, focused)

### After Approval

- Squash commits if too granular
- Maintainer merges to main
- Semantic versioning automated via semantic-release

## Project Structure

```
sven/
├── src/
│   ├── extension.ts          # Entry point
│   ├── commands/              # 54 command implementations
│   ├── repository/            # Core repository logic
│   ├── svn/                   # SVN CLI wrapper
│   ├── services/              # Extracted services
│   ├── parsers/               # SVN output parsers
│   └── util/                  # Utilities (logging, types)
├── test/                      # 930+ tests
├── docs/                      # Architecture, lessons learned
├── CLAUDE.md                  # AI development guidelines
├── README.md                  # User documentation
└── package.json               # Extension manifest
```

## Testing Deep Dive

### Running Tests

```bash
# All tests with coverage (HTML report in coverage/)
npm run test:coverage

# Unit tests only (no coverage)
npm run test:unit

# Single test file
npm run build:ts
npx vscode-test --files=out/test/specific.test.js
```

### Coverage Targets

- **Current**: 60-65% (930+ tests)
- **Target**: 50-60% (met and exceeded)
- **Focus**: Critical paths, services, commands

### Test Types

**E2E Tests** (primary):

- Real SVN repositories
- Real file system operations
- Integration with VS Code API
- Examples: `add.test.ts`, `commit.test.ts`

**Unit Tests** (secondary):

- Parsers (statusParser, logParser)
- Utilities (glob matching, encoding)
- Examples: `statusParser.test.ts`

### Test Infrastructure

- **Framework**: Mocha
- **Runner**: @vscode/test-cli
- **Coverage**: c8 (configured for HTML/text/lcov)
- **Mock**: Sinon (minimal usage)
- **Helpers**: Test repository creation in `test/helpers/`

## Resources

### Essential Reading

Before contributing, review:

1. [CLAUDE.md](./CLAUDE.md) - Development workflow
2. [LESSONS_LEARNED.md](./docs/LESSONS_LEARNED.md) - Patterns & anti-patterns
3. [ARCHITECTURE_ANALYSIS.md](./docs/ARCHITECTURE_ANALYSIS.md) - Technical details

### Documentation

- [README.md](./README.md) - User guide
- [BLAME_SYSTEM.md](./docs/BLAME_SYSTEM.md) - Blame feature docs
- [POSITRON_INTEGRATION.md](./docs/POSITRON_INTEGRATION.md) - Positron specifics
- [SECURITY.md](./.github/SECURITY.md) - Security & privacy policy

### Getting Help

- **Issues**: [GitHub Issues](https://github.com/vrognas/vrognas-sven/issues)
- **Discussions**: [GitHub Discussions](https://github.com/vrognas/vrognas-sven/discussions)
- **Security**: [Security Advisories](https://github.com/vrognas/vrognas-sven/security/advisories) (vulnerabilities only)

## Common Tasks

### Adding New Command

1. Write plan (numbered steps)
2. Write 3 tests in `test/commands/newCommand.test.ts`
3. Create `src/commands/newCommand.ts` extending `Command`
4. Register in `src/commands.ts`
5. Add to `package.json` contributions
6. Update CHANGELOG.md
7. Bump version

### Fixing Bug

1. Write failing test reproducing bug
2. Implement fix
3. Verify test passes
4. Run full test suite
5. Update CHANGELOG.md
6. Bump patch version

### Improving Performance

1. Profile with real usage data
2. Identify P0 bottleneck
3. Write tests capturing current behavior
4. Optimize (debounce, cache, batch, algorithm)
5. Verify tests pass
6. Measure impact (benchmark)
7. Document in LESSONS_LEARNED.md

### Extracting Service

1. Write 3 TDD tests for target behavior
2. Create stateless service with parameter objects
3. Extract verbatim (preserve exact behavior)
4. Move decorators to caller
5. Verify all tests pass
6. Refactor incrementally
7. Update ARCHITECTURE_ANALYSIS.md

## Code of Conduct

We follow the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

**Expected behavior:**

- Professional and respectful communication
- Constructive feedback
- Focus on code/ideas, not individuals
- Welcome diverse perspectives
- Help newcomers

**Unacceptable behavior:**

- Harassment, discrimination, trolling
- Personal attacks or insults
- Publishing private information
- Disruptive behavior

**Reporting:** Contact project maintainers at [security advisories](https://github.com/vrognas/vrognas-sven/security/advisories).

## License

By contributing, you agree that your contributions will be licensed under the same license as the project (MIT License).

---

**Questions?** Open an [issue](https://github.com/vrognas/vrognas-sven/issues) or [discussion](https://github.com/vrognas/vrognas-sven/discussions).

**Ready to contribute?** Start with issues labeled `good-first-issue` or `help-wanted`.

Thank you for contributing to Positron-SVN! 🚀
