import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface StreamReplyParams {
  systemPrompt: string
  history: ChatTurn[]
  signal: AbortSignal
}

export interface ExtractParams {
  systemPrompt: string
  transcript: string
  signal: AbortSignal
}

/**
 * The REAL token usage Anthropic's own API reports for one call —
 * `Message.usage.input_tokens`/`.output_tokens` from `@anthropic-ai/sdk`
 * (confirmed by reading the installed SDK's own type declarations before
 * this was added — see the Fase B report). Never an estimate: this type
 * only ever gets populated from a field the SDK itself returned.
 */
export interface AnthropicUsage {
  inputTokens: number
  outputTokens: number
}

export interface AssistantReplyResult {
  /** The full assistant reply text — identical to what streaming the generator's `delta` yields concatenates to. */
  text: string
  /** Real usage from `stream.finalMessage()`. Only `null` if the SDK's own response genuinely didn't carry a usable usage object — never fabricated. */
  usage: AnthropicUsage | null
  /** The model Anthropic itself reports served this call (`Message.model`) — not `config.anthropicModel` (what we requested), the API's own echoed-back value. */
  model: string
}

export interface ExtractionResult {
  /** Raw model text — the caller parses/validates this as JSON. */
  text: string
  /** Real usage from the non-streamed response. Populated whenever the API call itself succeeded, independent of whether `text` later turns out to be parseable JSON. */
  usage: AnthropicUsage | null
  model: string
}

/**
 * Provider/service abstraction over the underlying LLM vendor. Swapping AI
 * providers later means writing a new class that implements this interface
 * — nothing above this layer (routes, services) touches the Anthropic SDK
 * directly.
 */
export interface AIProvider {
  readonly isConfigured: boolean
  /** Yields assistant text deltas as they stream in; returns the full result (text + real usage + model) once done. */
  streamAssistantReply(params: StreamReplyParams): AsyncGenerator<string, AssistantReplyResult, void>
  /** Single non-streamed call — returns raw model text plus real usage (caller parses/validates the text as JSON). */
  extractStructuredText(params: ExtractParams): Promise<ExtractionResult>
}

const MAX_REPLY_TOKENS = 1024
const MAX_EXTRACTION_TOKENS = 800

class AnthropicProvider implements AIProvider {
  private client: Anthropic | null

  constructor() {
    this.client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null
  }

  get isConfigured(): boolean {
    return this.client !== null
  }

  private requireClient(): Anthropic {
    if (!this.client) {
      throw new Error('Anthropic client requested without ANTHROPIC_API_KEY configured.')
    }
    return this.client
  }

  async *streamAssistantReply({ systemPrompt, history, signal }: StreamReplyParams): AsyncGenerator<string, AssistantReplyResult, void> {
    const client = this.requireClient()

    const stream = client.messages.stream(
      {
        model: config.anthropicModel,
        max_tokens: MAX_REPLY_TOKENS,
        system: systemPrompt,
        messages: history.map((turn) => ({ role: turn.role, content: turn.content })),
      },
      { signal },
    )

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text
      }
    }

    // If the stream was aborted (or otherwise failed) before this resolves,
    // finalMessage() itself rejects — this generator then throws instead of
    // returning, and the caller never sees a fabricated usage/model for a
    // call that didn't actually complete. Only a genuinely resolved
    // Message ever reaches the `return` below.
    const finalMessage = await stream.finalMessage()
    const textBlock = finalMessage.content.find((block) => block.type === 'text')
    return {
      text: textBlock && textBlock.type === 'text' ? textBlock.text : '',
      usage: { inputTokens: finalMessage.usage.input_tokens, outputTokens: finalMessage.usage.output_tokens },
      model: finalMessage.model,
    }
  }

  async extractStructuredText({ systemPrompt, transcript, signal }: ExtractParams): Promise<ExtractionResult> {
    const client = this.requireClient()

    const response = await client.messages.create(
      {
        model: config.anthropicModel,
        max_tokens: MAX_EXTRACTION_TOKENS,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Transcripción de la conversación:\n\n${transcript}\n\nDevuelve el objeto JSON de evaluación.`,
          },
        ],
      },
      { signal },
    )

    const textBlock = response.content.find((block) => block.type === 'text')
    return {
      text: textBlock && textBlock.type === 'text' ? textBlock.text : '',
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      model: response.model,
    }
  }
}

export const aiProvider: AIProvider = new AnthropicProvider()

if (!aiProvider.isConfigured) {
  logger.warn('ANTHROPIC_API_KEY is not set — AI features are disabled. The app still runs without them.')
}
