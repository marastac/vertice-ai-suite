import type { BusinessType } from '@/entities/organization'
import type { CreateFormInput } from './form-repository'
import type { FormQuestion } from './types'

function question(input: {
  type: FormQuestion['type']
  label: string
  required: boolean
  points?: number
  options?: Array<{ label: string; points: number }>
}): FormQuestion {
  return {
    id: crypto.randomUUID(),
    type: input.type,
    label: input.label,
    required: input.required,
    points: input.points,
    options: input.options?.map((option) => ({ id: crypto.randomUUID(), label: option.label, points: option.points })),
  }
}

/**
 * One starter qualification form per business type, created once during
 * /onboarding (Phase 9 — see entities/organization/onboarding-service.ts)
 * so a brand-new organization has a real, editable example instead of an
 * empty /forms page. Status is always 'draft': the owner should review it
 * before publishing, not have it go live untouched. Every template includes
 * an `email` question — formBuilderSchema requires at least one before a
 * form can be saved, so the submission → Lead flow can never fail on a
 * missing contact address (see CLAUDE.md's "Submission → Lead flow" note).
 */
function getStarterFormContent(businessType: BusinessType): { name: string; description: string; questions: FormQuestion[] } {
  switch (businessType) {
    case 'content_creator':
      return {
        name: 'Formulario de colaboraciones y patrocinios',
        description: 'Califica propuestas de marcas y patrocinios antes de aceptar una colaboración.',
        questions: [
          question({ type: 'short_text', label: 'Nombre completo', required: true, points: 10 }),
          question({ type: 'email', label: 'Correo electrónico', required: true, points: 20 }),
          question({ type: 'short_text', label: 'Marca o proyecto', required: true, points: 10 }),
          question({
            type: 'single_choice',
            label: '¿Cuál es el presupuesto de la colaboración?',
            required: true,
            options: [
              { label: 'Menos de 300 €', points: 0 },
              { label: '300 € - 1.000 €', points: 15 },
              { label: '1.000 € - 3.000 €', points: 25 },
              { label: 'Más de 3.000 €', points: 30 },
            ],
          }),
          question({
            type: 'single_choice',
            label: '¿Cuándo te gustaría lanzar la colaboración?',
            required: true,
            options: [
              { label: 'Inmediatamente', points: 15 },
              { label: 'En 1-3 meses', points: 10 },
              { label: 'Más adelante', points: 0 },
            ],
          }),
          question({ type: 'long_text', label: 'Cuéntanos sobre tu marca o campaña', required: false, points: 5 }),
        ],
      }

    case 'course_creator':
      return {
        name: 'Formulario de inscripción a mi curso',
        description: 'Califica a los interesados en tu curso antes de invitarlos a inscribirse.',
        questions: [
          question({ type: 'short_text', label: 'Nombre completo', required: true, points: 10 }),
          question({ type: 'email', label: 'Correo electrónico', required: true, points: 15 }),
          question({
            type: 'single_choice',
            label: '¿Cuál es tu nivel de experiencia?',
            required: true,
            options: [
              { label: 'Principiante', points: 10 },
              { label: 'Intermedio', points: 15 },
              { label: 'Avanzado', points: 10 },
            ],
          }),
          question({
            type: 'yes_no',
            label: '¿Puedes invertir en el curso en este momento?',
            required: true,
            options: [
              { label: 'Sí', points: 25 },
              { label: 'No', points: 0 },
            ],
          }),
          question({
            type: 'single_choice',
            label: '¿Cuándo te gustaría empezar?',
            required: true,
            options: [
              { label: 'Inmediatamente', points: 25 },
              { label: 'En 1-3 meses', points: 15 },
              { label: 'Más adelante', points: 0 },
            ],
          }),
          question({ type: 'long_text', label: '¿Cuál es tu objetivo principal al tomar el curso?', required: false, points: 10 }),
        ],
      }

    case 'online_business':
      return {
        name: 'Formulario de interés en mis productos o servicios',
        description: 'Filtra clientes potenciales por presupuesto antes de contactarlos.',
        questions: [
          question({ type: 'short_text', label: 'Nombre completo', required: true, points: 10 }),
          question({ type: 'email', label: 'Correo electrónico', required: true, points: 15 }),
          question({ type: 'phone', label: 'Teléfono', required: false, points: 5 }),
          question({ type: 'short_text', label: '¿Qué producto o servicio te interesa?', required: true, points: 10 }),
          question({
            type: 'single_choice',
            label: 'Presupuesto aproximado disponible',
            required: true,
            options: [
              { label: 'Menos de 100 €', points: 0 },
              { label: '100 € - 500 €', points: 20 },
              { label: 'Más de 500 €', points: 35 },
            ],
          }),
        ],
      }
  }
}

export function buildStarterFormInput(organizationId: string, businessType: BusinessType): CreateFormInput {
  const content = getStarterFormContent(businessType)
  return {
    organizationId,
    name: content.name,
    description: content.description,
    status: 'draft',
    questions: content.questions,
  }
}
