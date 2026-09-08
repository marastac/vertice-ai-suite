const KNOWN_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Debes iniciar sesión para hacer esto.',
  NOT_ADMIN: 'No tienes permisos para gestionar miembros de esta organización.',
  INVALID_ROLE: 'Ese rol no es válido.',
  MEMBER_NOT_FOUND: 'No se encontró a esa persona en esta organización.',
  CANNOT_MODIFY_OWNER: 'No se puede cambiar el rol del propietario de la organización.',
  CANNOT_MODIFY_SELF: 'No puedes cambiar tu propio rol.',
  CANNOT_REMOVE_OWNER: 'No se puede eliminar al propietario de la organización.',
  CANNOT_REMOVE_SELF: 'No puedes eliminarte a ti mismo del equipo.',
}

/** Translates update_member_role()/remove_organization_member()'s known error codes to Spanish; falls back to the original message. */
export function translateMemberError(message: string): string {
  return KNOWN_MESSAGES[message] ?? message
}
