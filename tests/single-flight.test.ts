// Unit tests for src/entities/organization/single-flight.ts — the in-tab
// deduplication OrganizationProvider uses for first-login provisioning.
//
// The frontend has no test runner configured (see CLAUDE.md), so this uses
// Node's built-in test runner through the backend's existing `tsx` — no new
// dependency. Run from the repository root:
//   server/node_modules/.bin/tsx --test tests/single-flight.test.ts
//
// This file lives outside src/ on purpose: it is not part of the app build.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSingleFlight } from '../src/entities/organization/single-flight.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('concurrent calls for the same key run the task ONCE and share its result', async () => {
  const run = createSingleFlight<string>()
  const gate = deferred<string>()
  let executions = 0
  const task = () => {
    executions++
    return gate.promise
  }

  // e.g. React StrictMode's double effect + a TOKEN_REFRESHED, same user
  const calls = [run('user-1', task), run('user-1', task), run('user-1', task)]
  gate.resolve('org-1')

  assert.deepEqual(await Promise.all(calls), ['org-1', 'org-1', 'org-1'])
  assert.equal(executions, 1)
})

test('different keys (different users) never wait for or share each other', async () => {
  const run = createSingleFlight<string>()
  let executions = 0
  const task = (value: string) => async () => {
    executions++
    return value
  }

  const [a, b] = await Promise.all([run('user-a', task('org-a')), run('user-b', task('org-b'))])

  assert.equal(a, 'org-a')
  assert.equal(b, 'org-b')
  assert.equal(executions, 2)
})

test('once settled, the next call for the same key runs again (nothing is cached)', async () => {
  const run = createSingleFlight<number>()
  let executions = 0
  const task = async () => ++executions

  assert.equal(await run('user-1', task), 1)
  assert.equal(await run('user-1', task), 2)
})

test('a failure is shared by the concurrent callers but NOT cached — a retry runs fresh', async () => {
  const run = createSingleFlight<string>()
  const gate = deferred<string>()
  let executions = 0

  const first = run('user-1', () => {
    executions++
    return gate.promise
  })
  const second = run('user-1', async () => {
    executions++
    return 'never'
  })
  gate.reject(new Error('network down'))

  await assert.rejects(first, /network down/)
  await assert.rejects(second, /network down/)
  assert.equal(executions, 1)

  // The user reloads / the effect re-runs: a fresh attempt is made.
  assert.equal(await run('user-1', async () => {
    executions++
    return 'org-1'
  }), 'org-1')
  assert.equal(executions, 2)
})

test('an effect torn down and re-run mid-flight (StrictMode) still triggers only one execution', async () => {
  const run = createSingleFlight<string>()
  const gate = deferred<string>()
  let executions = 0
  const task = () => {
    executions++
    return gate.promise
  }

  // mount → start; unmount (the provider only flips `cancelled`); remount → start again
  const firstMount = run('user-1', task)
  const secondMount = run('user-1', task)
  gate.resolve('org-1')

  assert.equal(await firstMount, 'org-1')
  assert.equal(await secondMount, 'org-1')
  assert.equal(executions, 1)
})
