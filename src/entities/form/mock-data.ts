import { LOCAL_ORGANIZATION_ID } from '@/entities/organization'
import type { QualificationForm } from './types'

// Every mock form below belongs to the single local pseudo-organization —
// stamped on here rather than in each literal so this list stays a direct
// mirror of supabase/seed.sql's forms INSERT.
const mockFormsWithoutOrg: Omit<QualificationForm, 'organizationId'>[] = [
  {
    id: 'form-01',
    name: 'Formulario de colaboraciones y patrocinios',
    description: 'Califica propuestas de marcas y patrocinios antes de aceptar una colaboración.',
    status: 'active',
    createdAt: '2026-07-05T10:00:00Z',
    updatedAt: '2026-07-12T09:30:00Z',
    questions: [
      { id: 'form-01-q1', type: 'short_text', label: 'Nombre completo', required: true, points: 10 },
      { id: 'form-01-q2', type: 'email', label: 'Correo electrónico', required: true, points: 20 },
      { id: 'form-01-q3', type: 'phone', label: 'Teléfono', required: false, points: 5 },
      { id: 'form-01-q4', type: 'short_text', label: 'Marca o proyecto', required: true, points: 10 },
      {
        id: 'form-01-q5',
        type: 'single_choice',
        label: '¿Cuál es el presupuesto de la colaboración?',
        required: true,
        options: [
          { id: 'form-01-q5-o1', label: 'Menos de 300 €', points: 0 },
          { id: 'form-01-q5-o2', label: '300 € - 1.000 €', points: 15 },
          { id: 'form-01-q5-o3', label: '1.000 € - 3.000 €', points: 25 },
          { id: 'form-01-q5-o4', label: 'Más de 3.000 €', points: 30 },
        ],
      },
      {
        id: 'form-01-q6',
        type: 'single_choice',
        label: '¿Cuándo te gustaría lanzar la colaboración?',
        required: true,
        options: [
          { id: 'form-01-q6-o1', label: 'Inmediatamente', points: 15 },
          { id: 'form-01-q6-o2', label: 'En 1-3 meses', points: 10 },
          { id: 'form-01-q6-o3', label: 'Más adelante', points: 0 },
        ],
      },
      {
        id: 'form-01-q7',
        type: 'yes_no',
        label: '¿Tienes autoridad para aprobar el pago de la colaboración?',
        required: true,
        options: [
          { id: 'form-01-q7-yes', label: 'Sí', points: 15 },
          { id: 'form-01-q7-no', label: 'No', points: 0 },
        ],
      },
      { id: 'form-01-q8', type: 'long_text', label: 'Cuéntanos sobre tu marca o campaña', required: false, points: 5 },
    ],
  },
  {
    id: 'form-02',
    name: 'Formulario de inscripción a mi curso online',
    description: 'Califica a los interesados en tu curso antes de invitarlos a inscribirse.',
    status: 'active',
    createdAt: '2026-07-08T11:00:00Z',
    updatedAt: '2026-07-14T15:20:00Z',
    questions: [
      { id: 'form-02-q1', type: 'short_text', label: 'Nombre completo', required: true, points: 10 },
      { id: 'form-02-q2', type: 'email', label: 'Correo electrónico', required: true, points: 15 },
      {
        id: 'form-02-q3',
        type: 'single_choice',
        label: '¿Cuál es tu nivel de experiencia?',
        required: true,
        options: [
          { id: 'form-02-q3-o1', label: 'Principiante', points: 10 },
          { id: 'form-02-q3-o2', label: 'Intermedio', points: 15 },
          { id: 'form-02-q3-o3', label: 'Avanzado', points: 10 },
        ],
      },
      {
        id: 'form-02-q4',
        type: 'yes_no',
        label: '¿Puedes invertir en el curso en este momento?',
        required: true,
        options: [
          { id: 'form-02-q4-yes', label: 'Sí', points: 25 },
          { id: 'form-02-q4-no', label: 'No', points: 0 },
        ],
      },
      {
        id: 'form-02-q5',
        type: 'single_choice',
        label: '¿Cuándo te gustaría empezar?',
        required: true,
        options: [
          { id: 'form-02-q5-o1', label: 'Inmediatamente', points: 25 },
          { id: 'form-02-q5-o2', label: 'En 1-3 meses', points: 15 },
          { id: 'form-02-q5-o3', label: 'Más adelante', points: 0 },
        ],
      },
      { id: 'form-02-q6', type: 'long_text', label: '¿Cuál es tu objetivo principal al tomar el curso?', required: false, points: 10 },
    ],
  },
  {
    id: 'form-03',
    name: 'Formulario de interés en mis productos o servicios',
    description: 'Filtra clientes potenciales por presupuesto antes de contactarlos.',
    status: 'draft',
    createdAt: '2026-07-15T09:00:00Z',
    updatedAt: '2026-07-15T09:00:00Z',
    questions: [
      { id: 'form-03-q1', type: 'short_text', label: 'Nombre completo', required: true, points: 10 },
      { id: 'form-03-q2', type: 'email', label: 'Correo electrónico', required: true, points: 15 },
      { id: 'form-03-q3', type: 'short_text', label: '¿Qué producto o servicio te interesa?', required: true, points: 10 },
      { id: 'form-03-q4', type: 'number', label: 'Cantidad o volumen que necesitas', required: false, points: 5 },
      {
        id: 'form-03-q5',
        type: 'single_choice',
        label: 'Presupuesto aproximado disponible',
        required: true,
        options: [
          { id: 'form-03-q5-o1', label: 'Menos de 100 €', points: 0 },
          { id: 'form-03-q5-o2', label: '100 € - 500 €', points: 20 },
          { id: 'form-03-q5-o3', label: 'Más de 500 €', points: 35 },
        ],
      },
    ],
  },
]

export const mockForms: QualificationForm[] = mockFormsWithoutOrg.map((form) => ({
  ...form,
  organizationId: LOCAL_ORGANIZATION_ID,
}))
