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
 * Provider/service abstraction over the underlying LLM vendor. Swapping AI
 * providers later means writing a new class that implements this interface
 * — nothing above this layer (routes, services) touches the Anthropic SDK
 * directly.
 */
export interface AIProvider {
  readonly isConfigured: boolean
  /** Yields assistant text deltas as they stream in; returns the full text once done. */
  streamAssistantReply(params: StreamReplyParams): AsyncGenerator<string, string, void>
  /** Single non-streamed call that returns raw model text (caller parses/validates as JSON). */
  extractStructuredText(params: ExtractParams): Promise<string>
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

  async *streamAssistantReply({ systemPrompt, history, signal }: StreamReplyParams): AsyncGenerator<string, string, void> {
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

    const finalMessage = await stream.finalMessage()
    const textBlock = finalMessage.content.find((block) => block.type === 'text')
    return textBlock && textBlock.type === 'text' ? textBlock.text : ''
  }

  async extractStructuredText({ systemPrompt, transcript, signal }: ExtractParams): Promise<string> {
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
    return textBlock && textBlock.type === 'text' ? textBlock.text : ''
  }
}

export const aiProvider: AIProvider = new AnthropicProvider()

if (!aiProvider.isConfigured) {
  logger.warn('ANTHROPIC_API_KEY is not set — AI features are disabled. The app still runs without them.')
}
