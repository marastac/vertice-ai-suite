// Tests for src/entities/chat/chat-event-stream.ts — the public chat's SSE
// reader. Runs on Node's built-in test runner through the backend's `tsx`
// (included in `npm run test:all:safe`). No network: every stream is built
// in memory.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHAT_STREAM_INTERRUPTED_MESSAGE, readChatEventStream } from '../src/entities/chat/chat-event-stream.ts'
import type { StreamChatMessageHandlers } from '../src/entities/chat/chat-event-stream.ts'

const encoder = new TextEncoder()

/** A stream that emits `chunks` and then either closes or fails with `failWith`. */
function streamOf(chunks: string[], failWith?: Error): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]))
      } else if (failWith) {
        controller.error(failWith)
      } else {
        controller.close()
      }
    },
  })
}

function recorder() {
  const calls: string[] = []
  const handlers: StreamChatMessageHandlers = {
    onDelta: (text) => calls.push(`delta:${text}`),
    onQualification: (q) => calls.push(`qualification:${q === null ? 'null' : 'object'}`),
    onDone: () => calls.push('done'),
    onError: (message) => calls.push(`error:${message}`),
    onLimitReached: (message) => calls.push(`limit:${message}`),
  }
  return { calls, handlers }
}

const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

test('a normal reply: deltas, qualification and done — no error', async () => {
  const { calls, handlers } = recorder()
  await readChatEventStream(streamOf([event('delta', { text: 'Hola' }), event('delta', { text: ' 👋' }), event('qualification', { qualification: null }), event('done', {})]), handlers)
  assert.deepEqual(calls, ['delta:Hola', 'delta: 👋', 'qualification:null', 'done'])
})

test('events split across chunks (even inside a multi-byte character) are reassembled', async () => {
  const { calls, handlers } = recorder()
  const bytes = encoder.encode(event('delta', { text: 'canción' }) + event('done', {}))
  const cut = bytes.indexOf(0xc3) + 1 // in the middle of "ó"
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut))
      controller.enqueue(bytes.slice(cut))
      controller.close()
    },
  })
  await readChatEventStream(body, handlers)
  assert.deepEqual(calls, ['delta:canción', 'done'])
})

test('a connection dropped MID-REPLY never throws: partial text kept, one retryable error', async () => {
  const { calls, handlers } = recorder()
  await assert.doesNotReject(readChatEventStream(streamOf([event('delta', { text: 'Respuesta par' })], new TypeError('network error')), handlers))
  assert.deepEqual(calls, ['delta:Respuesta par', `error:${CHAT_STREAM_INTERRUPTED_MESSAGE}`])
})

test('a stream that ends WITHOUT a terminal event (server crashed) reports an error instead of vanishing', async () => {
  const { calls, handlers } = recorder()
  await readChatEventStream(streamOf([event('delta', { text: 'Hola' })]), handlers)
  assert.deepEqual(calls, ['delta:Hola', `error:${CHAT_STREAM_INTERRUPTED_MESSAGE}`])
})

test('an empty stream is an interrupted reply, not a silent success', async () => {
  const { calls, handlers } = recorder()
  await readChatEventStream(streamOf([]), handlers)
  assert.deepEqual(calls, [`error:${CHAT_STREAM_INTERRUPTED_MESSAGE}`])
})

test('a malformed event is skipped; the rest of the reply still arrives', async () => {
  const { calls, handlers } = recorder()
  await readChatEventStream(streamOf(['event: delta\ndata: {not json\n\n', event('delta', { text: 'ok' }), 'event: delta\ndata: null\n\n', event('done', {})]), handlers)
  assert.deepEqual(calls, ['delta:ok', 'done'])
})

test('the server error event is reported once, with its own message (no extra interrupted error)', async () => {
  const { calls, handlers } = recorder()
  await readChatEventStream(streamOf([event('error', { message: 'No se pudo generar una respuesta. Inténtalo de nuevo.' })]), handlers)
  assert.deepEqual(calls, ['error:No se pudo generar una respuesta. Inténtalo de nuevo.'])
})

test('conversation_limit_reached is a calm ending, never an error', async () => {
  const { calls, handlers } = recorder()
  await readChatEventStream(streamOf([event('conversation_limit_reached', { message: 'Gracias por conversar.' }), event('done', {})]), handlers)
  assert.deepEqual(calls, ['limit:Gracias por conversar.', 'done'])
})

test('a final event without the trailing blank line is still processed', async () => {
  const { calls, handlers } = recorder()
  await readChatEventStream(streamOf([event('delta', { text: 'a' }), 'event: done\ndata: {}']), handlers)
  assert.deepEqual(calls, ['delta:a', 'done'])
})

test('an intentional abort (visitor left the page) reports nothing', async () => {
  const { calls, handlers } = recorder()
  const controller = new AbortController()
  controller.abort()
  await readChatEventStream(streamOf([event('delta', { text: 'a' })], new DOMException('aborted', 'AbortError')), handlers, controller.signal)
  assert.deepEqual(calls, ['delta:a'])
})
