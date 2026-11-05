import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat config (ESLint 9).
 *
 * Deliberately scoped to what the compiler does NOT already cover. `tsconfig.json` is strict
 * and sets `noUnusedLocals` / `noUnusedParameters`, so those are left to `tsc`. The rules kept
 * here are the ones that catch real defects this codebase has already been bitten by:
 * floating promises (a dropped `await` on a delivery or a DB write fails silently) and
 * unchecked `any` flowing out of the agent kit, whose tool surface is typed `Promise<any>`.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '*.config.js',
      'scripts/**',
      // Generated: one ~75 KB base64 string literal. See scripts/build-fonts.mjs.
      'src/web/brand/fonts.generated.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // `tsconfig.json` excludes `test/`, so type-aware linting needs a project that spans
        // both.
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A dropped promise here means a transaction never delivered or a row never written,
      // with no error surfaced. `void` is the explicit opt-out and is used deliberately.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // The agent kit types its whole tool surface as `Promise<any>`, so unchecked `any` is
      // unavoidable at that seam — warn rather than error so it stays visible without
      // blocking, and is narrowed at the boundary instead of spreading.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',

      // Off: the Hedera SDK's value types (AccountId, TokenId, Hbar) are classes with a
      // meaningful `toString()`, and interpolating them is intentional and readable.
      // `no-base-to-string` stays ON and does catch the genuine case — untrusted input of
      // unknown shape, e.g. an Express query param that may be an object.
      '@typescript-eslint/restrict-template-expressions': 'off',

      // Off: `async` without `await` is the normal way to satisfy a Promise-returning
      // interface (strategy `handle`, hook methods, Express handlers) and flagging it says
      // nothing about correctness.
      '@typescript-eslint/require-await': 'off',

      // `const { drop: _drop, ...rest }` is the idiomatic way to omit a key; the discarded
      // binding is the point, so it should not be reported.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          ignoreRestSiblings: true,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // `catch {}` that silently swallows is how a guard stops guarding.
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },
  {
    // Tests reach into internals and stub kit types on purpose.
    files: ['test/**/*.ts'],
    rules: {
      // Test doubles are `async` to match an interface, not because they await anything.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-console': 'off',
    },
  },
);
