import { describe, expect, it } from 'vitest'
import { requireAdminRole } from '../src/services/webhook-auth.js'
import { AppError } from '../src/lib/errors.js'
import type { OrganizationRole } from '../src/services/webhook-auth.js'

// requireAdminRole() is the exact function PUT /config, POST /test, and
// POST /regenerate-secret all call to decide owner/admin vs. member/viewer
// — testing it directly exercises the real authorization boundary these
// routes rely on, without needing an HTTP test harness (this project has
// none yet — see the webhook audit this change resolves). A member/viewer
// calling any of those three endpoints, no matter how the request reaches
// the handler, is rejected by this same check.
describe('requireAdminRole', () => {
  it('allows owner', () => {
    expect(() => requireAdminRole('owner')).not.toThrow()
  })

  it('allows admin', () => {
    expect(() => requireAdminRole('admin')).not.toThrow()
  })

  it('rejects member with a 403 AppError', () => {
    expect(() => requireAdminRole('member')).toThrow(AppError)
    try {
      requireAdminRole('member')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).status).toBe(403)
    }
  })

  it('rejects viewer with a 403 AppError', () => {
    expect(() => requireAdminRole('viewer')).toThrow(AppError)
    try {
      requireAdminRole('viewer')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).status).toBe(403)
    }
  })

  it('rejects every non-admin role, exhaustively', () => {
    const nonAdminRoles: OrganizationRole[] = ['member', 'viewer']
    for (const role of nonAdminRoles) {
      expect(() => requireAdminRole(role), `${role} should be rejected`).toThrow(AppError)
    }
  })
})
