const KNOWN_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Debes iniciar sesión para aceptar esta invitación.',
  INVITE_NOT_FOUND: 'Esta invitación no existe o el enlace no es válido.',
  INVITE_NOT_USABLE: 'Esta invitación ya no está disponible (fue revocada, expiró o ya fue utilizada).',
  EMAIL_MISMATCH: 'Esta invitación fue enviada a otro correo electrónico. Inicia sesión con esa cuenta para aceptarla.',
}

/** Translates get_invite_by_token()/accept_invite()'s known error codes to Spanish; falls back to the original message. */
export function translateInviteError(message: string): string {
  return KNOWN_MESSAGES[message] ?? message
}
