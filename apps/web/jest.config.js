/** Unit tests for pure UI logic (no DOM, no React). */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/lib/**/*.spec.ts'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', target: 'ES2022', strict: true, esModuleInterop: true } }] },
};
