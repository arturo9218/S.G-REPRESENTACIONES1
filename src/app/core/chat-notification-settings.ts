export type ChatSoundPresetId = 'default' | 'double' | 'soft' | 'bell' | 'chime' | 'custom';

export interface ChatNotificationSettings {
  soundId: ChatSoundPresetId;
  /** Audio propio (data URL), si soundId === 'custom'. */
  customSoundDataUrl: string | null;
}

const STORAGE_KEY = 'ar_chat_notification_settings';

export const CHAT_SOUND_PRESETS: { id: ChatSoundPresetId; label: string }[] = [
  { id: 'default', label: 'Clásico (2 tonos)' },
  { id: 'double', label: 'Doble beep' },
  { id: 'soft', label: 'Suave' },
  { id: 'bell', label: 'Campana' },
  { id: 'chime', label: 'Campanita' },
  { id: 'custom', label: 'Mi archivo de audio' },
];

export function defaultChatNotificationSettings(): ChatNotificationSettings {
  return { soundId: 'default', customSoundDataUrl: null };
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

export async function readCustomSoundFile(file: File): Promise<string | null> {
  if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|m4a|aac)$/i.test(file.name)) {
    return null;
  }
  if (file.size > 800_000) {
    return null;
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
