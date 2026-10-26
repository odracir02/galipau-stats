import { IndexedDbRepository } from '../data/indexedDbRepository';
import type { Repository } from '../data/repository';

/** Repositorio único de la aplicación (hoy local; mañana local + sincronización). */
export const repo: Repository = new IndexedDbRepository();

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
