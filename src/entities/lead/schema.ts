import { z } from 'zod'

export const leadStatusSchema = z.enum(['new', 'qualifying', 'qualified', 'disqualified', 'converted'])
export const leadSourceSchema = z.enum(['chat', 'form', 'widget', 'manual'])

export type LeadStatus = z.infer<typeof leadStatusSchema>
export type LeadSource = z.infer<typeof leadSourceSchema>

export const LEAD_STATUSES = leadStatusSchema.options
export const LEAD_SOURCES = leadSourceSchema.options

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value)

const optionalTrimmedString = (max: number, message: string) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max, message).optional())

const optionalNonNegativeNumber = (message: string) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce.number({ error: message }).nonnegative('El valor no puede ser negativo.').optional(),
  )

export const leadFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Introduce un nombre de al menos 2 caracteres.')
    .max(120, 'El nombre es demasiado largo.'),
  email: z.email('Introduce un correo electrónico válido.'),
  phone: optionalTrimmedString(30, 'El teléfono es demasiado largo.'),
  company: z
    .string()
    .trim()
    .min(2, 'Introduce el nombre de la empresa.')
    .max(120, 'El nombre de la empresa es demasiado largo.'),
  position: optionalTrimmedString(120, 'El cargo es demasiado largo.'),
  source: leadSourceSchema,
  status: leadStatusSchema,
  estimatedBudget: optionalNonNegativeNumber('Introduce un importe numérico.'),
  assignedTo: optionalTrimmedString(60, 'Selección no válida.'),
  score: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: 'Introduce una puntuación numérica.' })
      .min(0, 'La puntuación mínima es 0.')
      .max(100, 'La puntuación máxima es 100.')
      .optional(),
  ),
  notes: optionalTrimmedString(2000, 'Las notas son demasiado largas.'),
})

export type LeadFormValues = z.output<typeof leadFormSchema>
export type LeadFormInput = z.input<typeof leadFormSchema>
