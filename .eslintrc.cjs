module.exports = {
  root: true,
  env: { es2022: true, node: true, browser: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  // `*.tmp.ts` are local bug-hunt probes, not product code. They are gitignored;
  // linting them would fail the zero-warning gate on files that never ship.
  ignorePatterns: ['dist', 'node_modules', 'cdk.out', 'docs', '*.cjs', '*.tmp.ts', '*.tmp.tsx'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
};
