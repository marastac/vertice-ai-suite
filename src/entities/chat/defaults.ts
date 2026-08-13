import type { ChatConfiguration } from './types'

/**
 * Neutral fallback template — used before an organization has been through
 * /onboarding (Phase 9) and by ChatSettingsPage's "Restablecer valores
 * predeterminados" button. Deliberately audience-agnostic (no mention of
 * "agencia" or any single business type); for copy tailored to a specific
 * audience, see entities/chat/business-type-templates.ts, applied once
 * during onboarding.
 */
export function createDefaultChatConfiguration(organizationId: string): ChatConfiguration {
  return {
    organizationId,
    assistantName: 'Asistente virtual',
    welcomeMessage: '¡Hola! 👋 Gracias por escribir. Cuéntame en qué puedo ayudarte y con gusto te oriento.',
    agencyDescription: 'Negocio digital que ofrece contenido, cursos o productos y servicios a través de internet.',
    servicesOffered: 'Productos, servicios o contenido digital ofrecidos a través de internet.',
    tone: 'professional',
    language: 'Español',
    questionsToCollect: [
      'Nombre y correo electrónico de contacto',
      'Qué te interesa (producto, servicio o curso)',
      'Presupuesto aproximado',
      'Cuándo te gustaría empezar',
    ],
    criteria: [
      { id: crypto.randomUUID(), label: 'Tiene una necesidad o interés claro', points: 30 },
      { id: crypto.randomUUID(), label: 'Cuenta con presupuesto disponible', points: 30 },
      { id: crypto.randomUUID(), label: 'Quiere avanzar pronto (menos de 1 mes)', points: 20 },
      { id: crypto.randomUUID(), label: 'Puede tomar la decisión por sí mismo/a', points: 20 },
    ],
    minQualifiedScore: 70,
    additionalInstructions: '',
    isActive: true,
    updatedAt: new Date().toISOString(),
  }
}
