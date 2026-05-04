/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ['@claims/eslint-config'],
  ignorePatterns: ['node_modules', 'dist', '.next', 'build', 'coverage', '**/prisma/migrations'],
};
