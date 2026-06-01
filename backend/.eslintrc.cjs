/* eslint-disable */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  ignorePatterns: ['dist', 'node_modules', '.eslintrc.cjs'],
  extends: ['eslint:recommended'],
  rules: {
    'no-unused-vars': 'off',
    'no-undef': 'off',
  },
};
