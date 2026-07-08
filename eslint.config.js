// ESLint v9 flat config
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  // Global ignores (replaces .eslintignore)
  {
    ignores: [
      '**/vscode.proposed.d.ts',
      'src/test/**/*.ts',
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
  {
    files: ['src/util/errorLogger.ts'],
    rules: {
      'no-console': 'off'
    }
  }
);
