import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openStatsDb } from './indexedDbRepository';

// Protección de los datos ya guardados en los dispositivos: cualquier cambio
// de versión o de almacenes de IndexedDB debe ser una migración deliberada.
describe('esquema local (IndexedDB)', () => {
  it('sigue en la versión 1 con sus cuatro almacenes e índices', async () => {
    const db = await openStatsDb('esquema-local');
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames].sort()).toEqual(['events', 'matches', 'players', 'teams']);
    const tx = db.transaction(['players', 'matches', 'events']);
    expect([...tx.objectStore('players').indexNames]).toEqual(['byTeam']);
    expect([...tx.objectStore('matches').indexNames]).toEqual(['byTeam']);
    expect([...tx.objectStore('events').indexNames]).toEqual(['byMatch']);
    db.close();
  });
});
