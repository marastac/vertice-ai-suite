import { describe, expect, it } from 'vitest'
import { computeBackoffMs, hasExhaustedAttempts, MAX_ATTEMPTS } from '../src/services/webhook-worker.js'

describe('computeBackoffMs', () => {
  it('follows the documented schedule: 1min, 5min, 30min, 2h', () => {
    expect(computeBackoffMs(1)).toBe(60_000)
    expect(computeBackoffMs(2)).toBe(5 * 60_000)
    expect(computeBackoffMs(3)).toBe(30 * 60_000)
    expect(computeBackoffMs(4)).toBe(2 * 60 * 60_000)
  })

  it('clamps to the last schedule entry beyond the schedule length', () => {
    expect(computeBackoffMs(5)).toBe(2 * 60 * 60_000)
    expect(computeBackoffMs(99)).toBe(2 * 60 * 60_000)
  })
})

describe('hasExhaustedAttempts', () => {
  it('is false before MAX_ATTEMPTS', () => {
    expect(hasExhaustedAttempts(MAX_ATTEMPTS - 1)).toBe(false)
  })

  it('is true at and beyond MAX_ATTEMPTS', () => {
    expect(hasExhaustedAttempts(MAX_ATTEMPTS)).toBe(true)
    expect(hasExhaustedAttempts(MAX_ATTEMPTS + 1)).toBe(true)
  })
})
