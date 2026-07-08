// ESLint v9 flat config
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  // Global ignores (replaces .eslintignore)
  {
    ignores: [
      '**/vscode.proposed.d.ts',
      'src/tools/**/*.ts',
      'dist/**',
      'out/**',
      'node_modules/**',
      '*.js', // Ignore JS config files
      'build.js',
      'css/**',
      'icons/**',
      'images/**',
      '**/*.json'
    ]
  },

  // Base TypeScript config
  ...tseslint.configs.recommended,

  // Custom rules for TypeScript files
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    },
    rules: {
      // TypeScript rules
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrors: 'none'
      }],
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',

      // Raw console leaks unsanitized data; route through util/errorLogger
      // (logError/logWarning) which strips credentials/paths. warn-level so
      // the remaining prod sites can be migrated incrementally.
      'no-console': 'warn',

      // Async-safety (typed-linting; requires parserOptions.project above).
      // The two promise-handling rules are the real bug class (unhandled
      // rejections, lost errors) and currently have zero violations, so they
      // are errors. await-thenable/require-await stay warn (existing debt).
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/require-await': 'warn'
    }
  },

  // errorLogger IS the sanitized console wrapper — it must use console.
  // errorSanitizer's console.warn calls are the debug-mode "sanitization is
  // OFF" alarms; routing them through the sanitizer would be circular.
  {
    files: ['src/util/errorLogger.ts', 'src/security/errorSanitizer.ts'],
    rules: {
      'no-console': 'off'
    }
  },

  // Tests: mocks legitimately use `any` and stub shapes, and console output
  // is fine — but the promise-safety rules stay at error (floating promises
  // in tests are a real flake class), and reassigning vscode-module exports
  // is banned in favor of vi.spyOn (auto-restored; see CLAUDE.md).
  {
    files: ['src/test/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/require-await': 'off',
      // typed `const x = require(...)` is used deliberately in a few suites
      // to sidestep mock hoisting; not worth churning
      '@typescript-eslint/no-require-imports': 'off',
      // test/ files sit outside the typed src block, so restate the
      // underscore-arg convention here
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrors: 'none'
      }],
      'no-console': 'off'
    }
  }
);
