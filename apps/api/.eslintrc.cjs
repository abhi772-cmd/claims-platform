/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ['@claims/eslint-config'],
  parserOptions: {
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: ['dist', 'node_modules', 'coverage', 'prisma/migrations'],
};
