import type { ChatConfiguration } from './types'

export function createDefaultChatConfiguration(): ChatConfiguration {
  return {
    assistantName: 'Asistente de Vértice',
    welcomeMessage:
      '¡Hola! 👋 Soy el asistente virtual de la agencia. Cuéntame un poco sobre tu proyecto y te ayudo a ver si encajamos bien.',
    agencyDescription:
      'Agencia de marketing digital especializada en captación y calificación de leads con inteligencia artificial.',
    servicesOffered: 'Marketing digital, generación de leads, automatización con IA, gestión de campañas publicitarias.',
    tone: 'professional',
    language: 'Español',
    questionsToCollect: [
      'Nombre y correo electrónico de contacto',
      'Tipo de negocio o industria',
      'Servicio de interés',
      'Presupuesto aproximado',
      'Plazo estimado para arrancar',
    ],
    criteria: [
      { id: crypto.randomUUID(), label: 'Tiene un presupuesto definido', points: 30 },
      { id: crypto.randomUUID(), label: 'La necesidad es clara y específica', points: 30 },
      { id: crypto.randomUUID(), label: 'Plazo de arranque próximo (menos de 3 meses)', points: 20 },
      { id: crypto.randomUUID(), label: 'Tiene autoridad para decidir la contratación', points: 20 },
    ],
    minQualifiedScore: 70,
    additionalInstructions: '',
    isActive: true,
    updatedAt: new Date().toISOString(),
  }
}
