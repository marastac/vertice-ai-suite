import { z } from 'zod'

// 'owner' deliberately excluded — an organization should have one natural
// owner (whoever created it); inviting someone else as owner has no clear
// use case yet and would be a needless privilege-escalation surface.
export const inviteMemberSchema = z.object({
  email: z.email('Introduce un correo electrónico válido.'),
  role: z.enum(['admin', 'member', 'viewer']),
})

export type InviteMemberValues = z.infer<typeof inviteMemberSchema>

// supportEmail/brandColor use z.preprocess to turn '' into undefined (an
// empty field means "clear this optional setting", not "save an empty
// string") — this gives the schema a different input type than output
// type, so SettingsPage.tsx's useForm must use the three-generic form. See
// entities/lead/schema.ts's LeadFormInput/LeadFormValues for the same
// documented pattern.
export const organizationSettingsSchema = z.object({
  name: z.string().trim().min(2, 'El nombre es demasiado corto.').max(120, 'El nombre es demasiado largo.'),
  supportEmail: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.email('Introduce un correo electrónico válido.').optional(),
  ),
  brandColor: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Usa un color hexadecimal, por ejemplo #6366F1.')
      .optional(),
  ),
})
export type OrganizationSettingsInput = z.input<typeof organizationSettingsSchema>
export type OrganizationSettingsValues = z.output<typeof organizationSettingsSchema>
