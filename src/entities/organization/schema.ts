import { z } from 'zod'

// 'owner' deliberately excluded — an organization should have one natural
// owner (whoever created it); inviting someone else as owner has no clear
// use case yet and would be a needless privilege-escalation surface.
export const inviteMemberSchema = z.object({
  email: z.email('Introduce un correo electrónico válido.'),
  role: z.enum(['admin', 'member', 'viewer']),
})

export type InviteMemberValues = z.infer<typeof inviteMemberSchema>
