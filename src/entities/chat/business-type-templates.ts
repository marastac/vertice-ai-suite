import type { BusinessType } from '@/entities/organization'
import type { ChatConfiguration } from './types'

/**
 * Applied once, during /onboarding (Phase 9, see entities/organization/onboarding-service.ts),
 * to replace the neutral fallback (entities/chat/defaults.ts) with copy
 * tailored to the organization's chosen audience. Not used anywhere else —
 * ChatSettingsPage's "Restablecer" button intentionally resets to the
 * neutral template, not back to this one (see CLAUDE.md's Phase 9 section
 * for why that's a deliberate, documented scope cut).
 */
export function createChatConfigurationForBusinessType(
  organizationId: string,
  businessType: BusinessType,
): ChatConfiguration {
  const base = {
    organizationId,
    tone: 'friendly' as const,
    language: 'Español',
    minQualifiedScore: 70,
    additionalInstructions: '',
    isActive: true,
    updatedAt: new Date().toISOString(),
  }

  switch (businessType) {
    case 'content_creator':
      return {
        ...base,
        assistantName: 'Asistente de colaboraciones',
        welcomeMessage:
          '¡Hola! 👋 Gracias por tu interés en colaborar o unirte a mi comunidad. Cuéntame qué te trae por aquí y te ayudo a ver cómo puedo apoyarte.',
        agencyDescription:
          'Creador/a de contenido enfocado en construir una comunidad y ofrecer colaboraciones, patrocinios o productos digitales.',
        servicesOffered: 'Colaboraciones de marca, patrocinios, mentorías, productos digitales y contenido para la comunidad.',
        questionsToCollect: [
          'Nombre y correo de contacto',
          'Tipo de colaboración o interés (patrocinio, mentoría, producto)',
          'Marca o proyecto que representas (si aplica)',
          'Presupuesto o rango disponible',
          'Plazo estimado para la colaboración',
        ],
        criteria: [
          { id: crypto.randomUUID(), label: 'Tiene un presupuesto o propuesta concreta', points: 30 },
          { id: crypto.randomUUID(), label: 'El interés está alineado con mi contenido o nicho', points: 25 },
          { id: crypto.randomUUID(), label: 'Puede confirmar en un plazo razonable', points: 25 },
          { id: crypto.randomUUID(), label: 'Tiene autoridad para decidir la colaboración', points: 20 },
        ],
      }

    case 'course_creator':
      return {
        ...base,
        assistantName: 'Asistente del curso',
        welcomeMessage:
          '¡Hola! 👋 Soy el asistente virtual de este curso. Cuéntame un poco sobre ti y tus objetivos, y te ayudo a ver si este programa es para ti.',
        agencyDescription:
          'Creador/a de un curso online o infoproducto enfocado en ayudar a los estudiantes a lograr un resultado concreto.',
        servicesOffered: 'Curso online, mentorías grupales o individuales, comunidad de estudiantes y materiales descargables.',
        questionsToCollect: [
          'Nombre y correo de contacto',
          'Nivel de experiencia actual',
          'Objetivo principal al tomar el curso',
          'Presupuesto disponible para invertir',
          'Cuándo te gustaría empezar',
        ],
        criteria: [
          { id: crypto.randomUUID(), label: 'Tiene un objetivo claro y específico', points: 25 },
          { id: crypto.randomUUID(), label: 'Puede invertir en el curso ahora', points: 30 },
          { id: crypto.randomUUID(), label: 'Quiere empezar pronto (menos de 1 mes)', points: 25 },
          { id: crypto.randomUUID(), label: 'Está listo/a para comprometerse con el proceso', points: 20 },
        ],
      }

    case 'online_business':
      return {
        ...base,
        assistantName: 'Asistente de la tienda',
        welcomeMessage: '¡Hola! 👋 Soy el asistente virtual de la tienda. Cuéntame qué buscas y te ayudo a encontrar la mejor opción para ti.',
        agencyDescription: 'Negocio que vende productos o servicios por internet y quiere calificar y dar seguimiento a clientes potenciales.',
        servicesOffered: 'Venta de productos/servicios online, atención al cliente y seguimiento de pedidos o consultas.',
        questionsToCollect: [
          'Nombre y correo de contacto',
          'Producto o servicio de interés',
          'Cantidad o volumen que necesita',
          'Presupuesto aproximado',
          'Cuándo necesita el producto o servicio',
        ],
        criteria: [
          { id: crypto.randomUUID(), label: 'Tiene intención de compra clara', points: 30 },
          { id: crypto.randomUUID(), label: 'El presupuesto es compatible con lo que ofrezco', points: 30 },
          { id: crypto.randomUUID(), label: 'Necesita el producto o servicio pronto', points: 20 },
          { id: crypto.randomUUID(), label: 'Puede tomar la decisión de compra', points: 20 },
        ],
      }
  }
}
