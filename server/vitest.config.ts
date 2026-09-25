import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Default (5s) was occasionally too tight for hubspot-oauth.test.ts's
    // module-reload-per-case pattern (vi.resetModules() + dynamic import,
    // to exercise config.isHubspotConfigured in both states) when the full
    // suite runs many files concurrently — verified in isolation those
    // tests finish in ~1s each; the flakiness was resource contention
    // across parallel test files, not a real hang.
    testTimeout: 15000,
  },
})
