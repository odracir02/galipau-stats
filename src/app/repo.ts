import { IndexedDbRepository } from '../data/indexedDbRepository';
import { ObservableRepository } from './observableRepository';

/**
 * Repositorio único de la aplicación: la base local de siempre, que además
 * avisa (después de guardar) de qué equipo ha cambiado, para el envío automático.
 */
export const repo = new ObservableRepository(new IndexedDbRepository());

/** Pide al navegador que no borre nuestros datos por falta de espacio (best effort). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
