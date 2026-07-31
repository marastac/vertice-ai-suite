import 'dotenv/config'

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return ['http://localhost:5173']
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined

export const config = {
  port: Number(process.env.PORT) || 8787,
  corsOrigins: parseOrigins(process.env.CORS_ORIGIN),
  anthropicApiKey,
  anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-4-8',
  isAiConfigured: Boolean(anthropicApiKey),
}
