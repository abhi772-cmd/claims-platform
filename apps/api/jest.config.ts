import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@common/(.*)$': '<rootDir>/src/common/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@config/(.*)$': '<rootDir>/src/config/$1',
    '^@claims/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^@claims/contracts/(.*)$': '<rootDir>/../../packages/contracts/src/$1',
    '^@claims/error-codes$': '<rootDir>/../../packages/error-codes/src/index.ts',
    '^@claims/error-codes/(.*)$': '<rootDir>/../../packages/error-codes/src/$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
  testTimeout: 15000,
};

export default config;
