const KNOWN_MESSAGES: Record<string, string> = {
  'Invalid login credentials': 'Correo o contraseña incorrectos.',
  'Email not confirmed': 'Debes confirmar tu correo electrónico antes de iniciar sesión.',
  'User already registered': 'Ya existe una cuenta con ese correo electrónico.',
  'A user with this email address has already been registered': 'Ya existe una cuenta con ese correo electrónico.',
  'Password should be at least 6 characters': 'La contraseña debe tener al menos 6 caracteres.',
  'Unable to validate email address: invalid format': 'El formato del correo electrónico no es válido.',
  'is invalid': 'Ese correo electrónico no es válido. Prueba con otro.',
  'Email rate limit exceeded': 'Se han solicitado demasiados correos. Inténtalo de nuevo en unos minutos.',
  'For security purposes, you can only request this after': 'Por seguridad, espera unos segundos antes de volver a intentarlo.',
  'New password should be different from the old password': 'La nueva contraseña debe ser distinta de la anterior.',
  'Auth session missing!': 'Tu enlace de recuperación ha expirado o no es válido. Solicita uno nuevo.',
}

/** Translates known Supabase Auth error messages to Spanish; falls back to the original message. */
export function translateAuthError(message: string): string {
  const exactMatch = KNOWN_MESSAGES[message]
  if (exactMatch) return exactMatch

  const lowerMessage = message.toLowerCase()
  const partialMatch = Object.entries(KNOWN_MESSAGES).find(([key]) => lowerMessage.includes(key.toLowerCase()))
  return partialMatch ? partialMatch[1] : message
}
