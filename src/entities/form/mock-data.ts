import type { QualificationForm } from './types'

export const mockForms: QualificationForm[] = [
  {
    id: 'form-01',
    name: 'Formulario de descubrimiento para agencias',
    description: 'Califica agencias potenciales antes de la primera llamada de descubrimiento.',
    status: 'active',
    createdAt: '2026-07-05T10:00:00Z',
    updatedAt: '2026-07-12T09:30:00Z',
    questions: [
      { id: 'form-01-q1', type: 'short_text', label: 'Nombre completo', required: true, points: 10 },
      { id: 'form-01-q2', type: 'email', label: 'Correo electrónico', required: true, points: 20 },
      { id: 'form-01-q3', type: 'phone', label: 'Teléfono', required: false, points: 5 },
      { id: 'form-01-q4', type: 'short_text', label: 'Empresa', required: true, points: 10 },
      {
        id: 'form-01-q5',
        type: 'single_choice',
        label: '¿Cuál es tu presupuesto mensual de marketing?',
        required: true,
        options: [
          { id: 'form-01-q5-o1', label: 'Menos de 1.000 €', points: 0 },
          { id: 'form-01-q5-o2', label: '1.000 € - 5.000 €', points: 15 },
          { id: 'form-01-q5-o3', label: '5.000 € - 15.000 €', points: 25 },
          { id: 'form-01-q5-o4', label: 'Más de 15.000 €', points: 30 },
        ],
      },
      {
        id: 'form-01-q6',
        type: 'single_choice',
        label: '¿Cuándo te gustaría empezar?',
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
        label: '¿Tienes autoridad para tomar decisiones de compra?',
        required: true,
        options: [
          { id: 'form-01-q7-yes', label: 'Sí', points: 15 },
          { id: 'form-01-q7-no', label: 'No', points: 0 },
        ],
      },
      { id: 'form-01-q8', type: 'long_text', label: 'Cuéntanos sobre tus objetivos', required: false, points: 5 },
    ],
  },
  {
    id: 'form-02',
    name: 'Calificador de encaje para ecommerce',
    description: 'Evalúa si una tienda online encaja con nuestros servicios de marketing.',
    status: 'active',
    createdAt: '2026-07-08T11:00:00Z',
    updatedAt: '2026-07-14T15:20:00Z',
    questions: [
      { id: 'form-02-q1', type: 'short_text', label: 'Nombre completo', required: true, points: 10 },
      { id: 'form-02-q2', type: 'email', label: 'Correo electrónico', required: true, points: 15 },
      { id: 'form-02-q3', type: 'short_text', label: 'Empresa', required: true, points: 10 },
      {
        id: 'form-02-q4',
        type: 'single_choice',
        label: '¿Qué plataforma de ecommerce utilizas?',
        required: true,
        options: [
          { id: 'form-02-q4-o1', label: 'Shopify', points: 15 },
          { id: 'form-02-q4-o2', label: 'WooCommerce', points: 10 },
          { id: 'form-02-q4-o3', label: 'Otra', points: 5 },
          { id: 'form-02-q4-o4', label: 'Ninguna todavía', points: 0 },
        ],
      },
      {
        id: 'form-02-q5',
        type: 'single_choice',
        label: '¿Cuál es tu facturación mensual aproximada?',
        required: true,
        options: [
          { id: 'form-02-q5-o1', label: 'Menos de 5.000 €', points: 0 },
          { id: 'form-02-q5-o2', label: '5.000 € - 20.000 €', points: 15 },
          { id: 'form-02-q5-o3', label: 'Más de 20.000 €', points: 25 },
        ],
      },
      {
        id: 'form-02-q6',
        type: 'yes_no',
        label: '¿Inviertes actualmente en publicidad digital?',
        required: true,
        options: [
          { id: 'form-02-q6-yes', label: 'Sí', points: 15 },
          { id: 'form-02-q6-no', label: 'No', points: 0 },
        ],
      },
    ],
  },
  {
    id: 'form-03',
    name: 'Filtro de presupuesto empresarial',
    description: 'Filtra leads empresariales por presupuesto disponible antes de asignar un ejecutivo de cuentas.',
    status: 'draft',
    createdAt: '2026-07-15T09:00:00Z',
    updatedAt: '2026-07-15T09:00:00Z',
    questions: [
      { id: 'form-03-q1', type: 'short_text', label: 'Nombre completo', required: true, points: 10 },
      { id: 'form-03-q2', type: 'email', label: 'Correo electrónico', required: true, points: 15 },
      { id: 'form-03-q3', type: 'short_text', label: 'Empresa', required: true, points: 10 },
      { id: 'form-03-q4', type: 'number', label: 'Número de empleados', required: false, points: 5 },
      {
        id: 'form-03-q5',
        type: 'single_choice',
        label: 'Presupuesto anual disponible',
        required: true,
        options: [
          { id: 'form-03-q5-o1', label: 'Menos de 10.000 €', points: 0 },
          { id: 'form-03-q5-o2', label: '10.000 € - 50.000 €', points: 20 },
          { id: 'form-03-q5-o3', label: 'Más de 50.000 €', points: 35 },
        ],
      },
    ],
  },
]
