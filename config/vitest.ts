import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    exclude: ['ref_project/**', 'lib/**', 'node_modules/**'],
  },
})
