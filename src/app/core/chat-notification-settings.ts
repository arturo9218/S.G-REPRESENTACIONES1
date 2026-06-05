export type ChatSoundPresetId = 'default' | 'double' | 'soft' | 'bell' | 'chime' | 'custom';

export interface ChatNotificationSettings {
  soundId: ChatSoundPresetId;
  /** Audio propio (data URL), si soundId === 'custom'. */
  customSoundDataUrl: string | null;
  /** Nombre del archivo elegido en el celular (solo referencia). */
  customSoundFileName: string | null;
}

const STORAGE_KEY = 'ar_chat_notification_settings';

export const CHAT_SOUND_PRESETS: { id: ChatSoundPresetId; label: string }[] = [
  { id: 'default', label: 'Clásico (2 tonos)' },
  { id: 'double', label: 'Doble beep' },
  { id: 'soft', label: 'Suave' },
  { id: 'bell', label: 'Campana' },
  { id: 'chime', label: 'Campanita' },
  { id: 'custom', label: 'Tono del celular (archivo)' },
];

export function defaultChatNotificationSettings(): ChatNotificationSettings {
  return { soundId: 'default', customSoundDataUrl: null, customSoundFileName: null };
}

export function loadChatNotificationSettings(): ChatNotificationSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultChatNotificationSettings();
    const o = JSON.parse(raw) as Partial<ChatNotificationSettings>;
    return {
      soundId: (o.soundId as ChatSoundPresetId) ?? 'default',
      customSoundDataUrl:
        typeof o.customSoundDataUrl === 'string' ? o.customSoundDataUrl : null,
      customSoundFileName:
        typeof o.customSoundFileName === 'string' ? o.customSoundFileName : null,
    };
  } catch {
    return defaultChatNotificationSettings();
  }
}

export function saveChatNotificationSettings(s: ChatNotificationSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* quota */
  }
}

export interface CustomSoundLoadResult {
  dataUrl: string;
  fileName: string;
}

/** Tono del celular: mp3, m4a, etc. (máx. ~2,5 MB; conviene un fragmento corto). */
export async function readCustomSoundFile(file: File): Promise<CustomSoundLoadResult | null> {
  const okType =
    file.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|mpeg|mp4)$/i.test(file.name);
  if (!okType) return null;
  if (file.size > 2_500_000) return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : null;
      if (!dataUrl) {
        resolve(null);
        return;
      }
      resolve({ dataUrl, fileName: file.name || 'tono-personalizado' });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
