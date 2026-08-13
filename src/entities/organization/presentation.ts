import type { BusinessType } from './types'

export const BUSINESS_TYPES: BusinessType[] = ['content_creator', 'course_creator', 'online_business']

export const businessTypeLabel: Record<BusinessType, string> = {
  content_creator: 'Creador de contenido',
  course_creator: 'Curso online',
  online_business: 'Negocio que vende por internet',
}

export const businessTypeDescription: Record<BusinessType, string> = {
  content_creator: 'Construyes una audiencia y trabajas con marcas, patrocinios o productos digitales.',
  course_creator: 'Vendes un curso, mentoría o infoproducto y quieres calificar a los interesados antes de inscribirlos.',
  online_business: 'Vendes productos o servicios por internet y quieres calificar y dar seguimiento a tus clientes.',
}
