import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const noComments = {
  meta: { type: 'suggestion', docs: { description: 'disallow comments in source code' }, schema: [] },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === 'Shebang') continue;
          context.report({
            loc: comment.loc,
            message: 'Comments are not allowed in source code (project convention).',
          });
        }
      },
    };
  },
};

const RAW_SQL_MESSAGE =
  'Raw SQL bypasses the tenant-scoping Prisma extension. Use the scoped client, or add a method to a repository in packages/core/src/raw with a tenant-filter test.';

const rawSqlRestrictions = [
  {
    selector: 'MemberExpression[property.name=/^\\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)$/]',
    message: RAW_SQL_MESSAGE,
  },
  { selector: "MemberExpression[object.name='Prisma'][property.name=/^(sql|raw|join)$/]", message: RAW_SQL_MESSAGE },
];

const pgImportRestriction = {
  paths: [{ name: 'pg', message: RAW_SQL_MESSAGE }],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/src/generated/**',
      'playwright-report/**',
      'test-results/**',
      '.smoke/**',
      '.loadtest/**',
      'vendor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { local: { rules: { 'no-comments': noComments } } },
    rules: {
      'local/no-comments': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-restricted-syntax': ['error', ...rawSqlRestrictions],
      'no-restricted-imports': ['error', pgImportRestriction],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
    },
  },
  {
    files: [
      'packages/core/src/raw/**/*.ts',
      'packages/core/src/db/admin.ts',
      '**/test/**/*.{ts,tsx}',
      'e2e/**/*.ts',
      'scripts/**/*.{js,mjs,ts}',
      'loadtest/**/*.{js,mjs,ts}',
    ],
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['**/test/**/*.{ts,tsx}', 'e2e/**/*.ts', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
