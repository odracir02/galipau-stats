// Instalación de la aplicación en la pantalla de inicio: plataforma, si ya se
// está usando instalada y, en los navegadores que lo permiten (Chrome en
// Android), el aviso de instalación propio del navegador. Solo informa: la
// instalación siempre la confirma el usuario en el navegador.
import { useSyncExternalStore } from 'react';

export type InstallPlatform = 'ios' | 'android';

/** Lo que el navegador deja ver del dispositivo. */
export interface DeviceHints {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

/**
 * iPhone/iPad, Android o null si no se reconoce (ordenador u otro). El iPad
 * reciente se presenta como un Mac con pantalla táctil.
 */
export function detectPlatform({ userAgent, platform, maxTouchPoints }: DeviceHints): InstallPlatform | null {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (platform === 'MacIntel' && maxTouchPoints > 1) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return null;
}

/** En iPhone/iPad, un navegador distinto de Safari (Chrome, Firefox, Edge…). */
export const isOtherIosBrowser = (userAgent: string): boolean => /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(userAgent);

/** La aplicación se está usando desde la pantalla de inicio (instalada). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export const deviceHints = (): DeviceHints => ({
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  maxTouchPoints: navigator.maxTouchPoints ?? 0,
});

// --- Aviso de instalación del navegador ---------------------------------------

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface InstallState {
  /** El navegador permite abrir su aviso de instalación desde la aplicación. */
  canPrompt: boolean;
  /** Se acaba de instalar desde este navegador. */
  installed: boolean;
}

let deferred: InstallPromptEvent | null = null;
let state: InstallState = { canPrompt: false, installed: false };
const listeners = new Set<() => void>();
let listening = false;

function set(next: InstallState) {
  state = next;
  for (const l of listeners) l();
}

/**
 * Guarda el aviso de instalación para ofrecerlo en el tutorial. El navegador lo
 * anuncia una sola vez y al poco de abrir la aplicación, por eso se escucha desde
 * el arranque. No se muestra nada por sí solo. Llamarla otra vez no añade más
 * escuchadores.
 */
export function listenForInstall(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    set({ ...state, canPrompt: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    set({ canPrompt: false, installed: true });
  });
}

/** Abre el aviso del navegador. Devuelve si el usuario ha aceptado. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  // El aviso solo se puede abrir una vez.
  deferred = null;
  set({ ...state, canPrompt: false });
  try {
    await e.prompt();
    return (await e.userChoice).outcome === 'accepted';
  } catch {
    return false;
  }
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
