import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { AccountStore, LinkTakenError, type TeamLink } from './store';

const link = (local: string, remote: string): TeamLink => ({
  localTeamId: local,
  remoteTeamId: remote,
  remoteTeamName: 'Senior Masculino A',
  remoteTeamCode: 'SMA2627',
  remoteSeason: '2026/27',
  clubName: 'Club de prueba',
  linkedAt: '2026-10-29T10:00:00.000Z',
});

describe('almacén de la cuenta', () => {
  it('pasar de la versión 1 a la 2 conserva la sesión guardada (solo añade almacenes)', async () => {
    // Base tal como la dejó la versión anterior de la app (005E.2C).
    const old = await openDB('cuenta-v1', 1, { upgrade: (db) => void db.createObjectStore('account') });
    await old.put('account', { deviceId: 'd1', token: 'token-guardado', joinedAt: '2026-10-29T09:00:00.000Z' }, 'device');
    await old.put('account', { teams: [], checkedAt: '2026-10-29T09:00:00.000Z' }, 'teams');
    old.close();
    const store = new AccountStore('cuenta-v1');
    expect(await store.getDevice()).toMatchObject({ deviceId: 'd1', token: 'token-guardado' });
    expect(await store.getTeams()).toMatchObject({ checkedAt: '2026-10-29T09:00:00.000Z' });
    await store.addLink(link('local-1', 'remoto-1'));
    expect(await store.getLink('local-1')).toMatchObject({ remoteTeamId: 'remoto-1' });
  });

  it('un vínculo nunca se sustituye: ni el equipo local ni el del club se repiten', async () => {
    const store = new AccountStore('cuenta-vinculos');
    await store.addLink(link('local-1', 'remoto-1'));
    await expect(store.addLink(link('local-1', 'remoto-2'))).rejects.toBeInstanceOf(LinkTakenError);
    await expect(store.addLink(link('local-2', 'remoto-1'))).rejects.toBeInstanceOf(LinkTakenError);
    expect(await store.listLinks()).toEqual([link('local-1', 'remoto-1')]);
  });

  it('cerrar sesión no olvida los vínculos ni lo ya enviado', async () => {
    const store = new AccountStore('cuenta-cierre');
    await store.saveDevice({ deviceId: 'd1', token: 't', joinedAt: '2026-10-29T09:00:00.000Z' });
    await store.addLink(link('local-1', 'remoto-1'));
    await store.saveMeta({ key: 'player:p1', entity: 'player', entityId: 'p1', remoteTeamId: 'remoto-1', version: 1, hash: 'h', syncedAt: '2026-10-29T10:00:00.000Z' });
    await store.clear();
    expect(await store.getDevice()).toBeNull();
    expect(await store.getLink('local-1')).not.toBeNull();
    expect(await store.listMeta('remoto-1')).toHaveLength(1);
  });
});
