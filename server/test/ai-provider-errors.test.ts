import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { isConfirmedUnbilledRejection } from '../src/services/ai-provider.js'

// isConfirmedUnbilledRejection() decides when a failed Anthropic call may be
// settled at ZERO in the monthly quota. It must be true ONLY for HTTP error
// responses with reliable no-billing evidence (401, 413) and false for every
// failure whose real usage is unknown. Built from the SDK's own error
// classes/factory (APIError.generate is what the SDK itself uses for HTTP
// error responses), so these mirror real runtime errors.

const headers = new Headers({ 'request-id': 'req_local_test' })
const body = (type: string) => ({ type: 'error', error: { type, message: 'x' } })
const httpError = (status: number, type: string) => Anthropic.APIError.generate(status, body(type), undefined, headers)

describe('isConfirmedUnbilledRejection', () => {
  it.each([
    [401, 'authentication_error'],
    [413, 'request_too_large'],
  ])('HTTP %i (%s) response → confirmed unbilled', (status, type) => {
    expect(isConfirmedUnbilledRejection(httpError(status, type))).toBe(true)
  })

  it.each([
    [400, 'invalid_request_error'],
    [402, 'billing_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [429, 'rate_limit_error'],
    [500, 'api_error'],
    [504, 'timeout_error'],
    [529, 'overloaded_error'],
  ])('HTTP %i (%s) → NOT confirmed (no documented billing evidence) → estimate kept', (status, type) => {
    expect(isConfirmedUnbilledRejection(httpError(status, type))).toBe(false)
  })

  it('a 401-like error WITHOUT response headers (not a real HTTP response) is not trusted', () => {
    expect(isConfirmedUnbilledRejection(new Anthropic.APIError(401, body('authentication_error'), 'x', undefined))).toBe(false)
  })

  it('an error delivered mid-stream as an SSE `error` event (status undefined) is never zero-cost', () => {
    expect(isConfirmedUnbilledRejection(new Anthropic.APIError(undefined, body('overloaded_error'), undefined, headers))).toBe(false)
  })

  it.each([
    ['user abort (visitor disconnected)', new Anthropic.APIUserAbortError()],
    ['connection error', new Anthropic.APIConnectionError({ message: 'socket hang up' })],
    ['timeout', new Anthropic.APIConnectionTimeoutError()],
  ])('%s → unknown cost', (_label, error) => {
    expect(isConfirmedUnbilledRejection(error)).toBe(false)
  })

  it.each([
    ['plain Error', new Error('401 something')],
    ['DOMException AbortError', new DOMException('aborted', 'AbortError')],
    ['string', '401'],
    ['undefined', undefined],
  ])('non-SDK value (%s) → never zero-cost', (_label, value) => {
    expect(isConfirmedUnbilledRejection(value)).toBe(false)
  })
})
