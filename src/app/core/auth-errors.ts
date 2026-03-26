export function mapSignInError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login') || m.includes('invalid credentials')) {
    return 'Correo o contraseña incorrectos.';
  }
  if (m.includes('email not confirmed')) {
    return 'Confirmá tu correo antes de iniciar sesión.';
  }
  return message;
}

export function mapSignUpError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('already registered') || m.includes('user already')) {
    return 'Ya existe una cuenta con este correo.';
  }
  if (m.includes('password')) {
    return 'La contraseña no cumple los requisitos del servidor.';
  }
  return message;
}

export function mapRecoveryEmailError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('rate limit') || m.includes('too many')) {
    return 'Se enviaron demasiados correos en poco tiempo. Esperá unos minutos o hasta una hora y volvé a intentar (límite de Supabase para evitar spam).';
  }
  return message;
}
