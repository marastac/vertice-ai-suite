import { afterEach, describe, expect, it, vi } from 'vitest'

// GUARD for the quota cost model (DISENO_RIESGO_3.txt, P13/P14): the quota
// prices every call with plain input/output rates, which is only correct
// while requests use none of the features billed differently (prompt
// caching, fast mode, inference_geo, …). If someone adds one of them, this
// test fails on purpose so the cost model gets revisited at the same time.
//
// NO NETWORK, NO REAL KEY, NO PAID CALL — three independent safeguards:
//   1. @anthropic-ai/sdk is replaced by a fake client (nothing is sent).
//   2. ANTHROPIC_API_KEY is stubbed to a fake value BEFORE config loads
//      (dotenv never overrides an existing variable); asserted below.
//   3. ANTHROPIC_BASE_URL points at a closed local port, so even the real SDK
//      could not reach Anthropic.

const FAKE_KEY = 'test-key-not-real'
const ALLOWED_REQUEST_KEYS = ['max_tokens', 'messages', 'model', 'system']

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.doUnmock('@anthropic-ai/sdk')
})

function message(usage: Record<string, number | null>) {
  return {
    content: [{ type: 'text', text: 'Hola' }],
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null, ...usage },
    model: 'model-echoed-by-api',
  }
}

async function loadProvider(reply: ReturnType<typeof message>) {
  vi.stubEnv('ANTHROPIC_API_KEY', FAKE_KEY)
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9')

  const streamParams: Record<string, unknown>[] = []
  const createParams: Record<string, unknown>[] = []
  const constructed: unknown[] = []

  vi.doMock('@anthropic-ai/sdk', async () => {
    const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')
    class FakeAnthropic {
      static APIError = actual.default.APIError
      static APIUserAbortError = actual.default.APIUserAbortError
      static APIConnectionError = actual.default.APIConnectionError
      messages = {
        stream: (params: Record<string, unknown>) => {
          streamParams.push(params)
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hola' } }
            },
            finalMessage: async () => reply,
          }
        },
        create: async (params: Record<string, unknown>) => {
          createParams.push(params)
          return reply
        },
      }
      constructor(options: unknown) {
        constructed.push(options)
      }
    }
    return { ...actual, default: FakeAnthropic }
  })

  const { aiProvider } = await import('../src/services/ai-provider.js')
  const { config } = await import('../src/config.js')
  return { aiProvider, config, streamParams, createParams, constructed }
}

async function runReply(aiProvider: Awaited<ReturnType<typeof loadProvider>>['aiProvider']) {
  const generator = aiProvider.streamAssistantReply({
    systemPrompt: 'sistema',
    history: [{ role: 'user', content: 'hola' }],
    signal: new AbortController().signal,
  })
  let next = await generator.next()
  while (!next.done) next = await generator.next()
  return next.value
}

describe('Anthropic requests stay within the quota cost model', () => {
  it('safety: the fake key is the one in use (no real credential, no network)', async () => {
    const { config, constructed } = await loadProvider(message({}))
    expect(config.anthropicApiKey).toBe(FAKE_KEY)
    expect(constructed).toEqual([{ apiKey: FAKE_KEY }])
  })

  it('reply and extraction send ONLY model, max_tokens, system and messages — no caching, fast mode, inference_geo, thinking…', async () => {
    const { aiProvider, config, streamParams, createParams } = await loadProvider(message({}))

    await runReply(aiProvider)
    await aiProvider.extractStructuredText({ systemPrompt: 'extracción', transcript: 'Visitante: hola', signal: new AbortController().signal })

    for (const params of [...streamParams, ...createParams]) {
      expect(Object.keys(params).sort()).toEqual(ALLOWED_REQUEST_KEYS)
      expect(JSON.stringify(params)).not.toContain('cache_control')
      // Both calls use exactly the configured model — the one the quota reserves with.
      expect(params.model).toBe(config.anthropicModel)
    }
    expect(streamParams).toHaveLength(1)
    expect(createParams).toHaveLength(1)
  })

  it('maps null cache-token fields to 0 and passes real ones through (both calls)', async () => {
    const plain = await loadProvider(message({}))
    expect((await runReply(plain.aiProvider)).usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    })

    vi.resetModules()
    const cached = await loadProvider(message({ cache_creation_input_tokens: 3, cache_read_input_tokens: 7 }))
    const extraction = await cached.aiProvider.extractStructuredText({
      systemPrompt: 'extracción',
      transcript: 'Visitante: hola',
      signal: new AbortController().signal,
    })
    expect(extraction.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 3, cacheReadInputTokens: 7 })
    // The model reported back is the API's own value, untouched.
    expect(extraction.model).toBe('model-echoed-by-api')
  })
})
