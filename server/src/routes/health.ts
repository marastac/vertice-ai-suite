import { Router } from 'express'
import { config } from '../config.js'
import { aiProvider } from '../services/ai-provider.js'

export const healthRouter = Router()

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    aiConfigured: aiProvider.isConfigured,
    model: config.isAiConfigured ? config.anthropicModel : null,
    timestamp: new Date().toISOString(),
  })
})
