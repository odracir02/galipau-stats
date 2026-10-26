import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Aviso breve y no bloqueante. Los errores permanecen más tiempo. */
export function showToast(text: string, kind: Toast['kind'] = 'ok'): void {
  const toast = { id: nextId++, kind, text };
  // Solo el último aviso de confirmación: no se apilan durante el registro rápido.
  toasts = [...toasts.filter((t) => t.kind === 'error'), toast].slice(-3);
  emit();
  window.setTimeout(() => dismissToast(toast.id), kind === 'error' ? 7000 : 1800);
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
}
