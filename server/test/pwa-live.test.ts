// Actualización en directo de la consulta (src/remote/live.ts y ClubViewer.poll)
// contra el Worker real, en memoria: el iPhone registra y envía; los móviles de
// consulta lo ven sin pulsar «Actualizar». Nunca toca datos reales ni D1 Preview.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbRepository } from '../../src/data/indexedDbRepository';
import type { Match, Team } from '../../src/domain/types';
import { loadSeasonItems } from '../../src/services/statsService';
import * as svc from '../../src/services/matchService';
import { createTeam, savePlayer } from '../../src/services/teamService';
import { computeMatchStats, computeSeasonStats } from '../../src/stats/engine';
import { RANKINGS, rankPlayers, seasonCandidates } from '../../src/stats/rankings';
import { createApi, type Api, type RemoteTeam } from '../../src/remote/api';
import { ClubSync } from '../../src/remote/clubsync';
import { LiveFeed } from '../../src/remote/live';
import { AccountStore } from '../../src/remote/store';
import { stableJson } from '../../src/remote/upload';
import { ClubViewer, seasonItems, ViewerStore } from '../../src/remote/viewer';
import worker, { type Env } from '../src/index';
import { addClub, addDevice, addTeam, CODE_KEY, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const REMOTE = 'remoto-sma';
let n = 0;
let db: SqliteD1;
let env: Env;
let local: IndexedDbRepository;
let localTeam: Team;
let match: Match;
let ids: string[];
let iphone: ClubSync;
let viewerTokens: string[];
let coachNet: ReturnType<typeof network>;
const feeds: LiveFeed[] = [];
let clock = Date.UTC(2026, 9, 31, 18, 0, 0);
const now = () => new Date(clock);

const remoteTeam = (role: RemoteTeam['role'] = 'viewer'): RemoteTeam => ({
  teamId: REMOTE,
  role,
  status: 'active',
  name: 'Senior Masculino A',
  code: 'SMA2627',
  season: '2026/27',
  clubId: 'A',
  clubName: 'Club A',
});

/** Red de un dispositivo: cuenta sus peticiones, puede caerse y retrasar respuestas. */
function network() {
  const net = {
    down: false,
    delayMs: 0,
    /** Retiene el envío de acciones hasta que se resuelva (simula que llegan después). */
    hold: null as Promise<void> | null,
    inFlight: 0,
    maxInFlight: 0,
    requests: [] as string[],
    api: null as unknown as Api,
  };
  net.api = createApi({
    baseUrl: 'https://api.example',
    fetch: async (input, init) => {
      const url = new URL(input as string);
      net.requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      if (net.down) throw new TypeError('Failed to fetch');
      net.inFlight++;
      net.maxInFlight = Math.max(net.maxInFlight, net.inFlight);
      try {
        if (net.delayMs) await new Promise((r) => setTimeout(r, net.delayMs));
        if (net.hold && url.pathname === '/api/sync/events') await net.hold;
        return await worker.fetch(new Request(input as string, init), env);
      } finally {
        net.inFlight--;
      }
    },
  });
  return net;
}

/** Temporizadores manuales: el directo avanza solo cuando la prueba lo dice. */
function manualTimers() {
  let id = 0;
  const queue = new Map<number, { fn: () => void; ms: number }>();
  return {
    queue,
    set: (fn: () => void, ms: number) => {
      queue.set(++id, { fn, ms });
      return id;
    },
    clear: (h: unknown) => void queue.delete(h as number),
    /** Ejecuta lo programado y devuelve las esperas que tenía. */
    fire(): number[] {
      const all = [...queue.values()];
      queue.clear();
      for (const t of all) t.fn();
      return all.map((t) => t.ms);
    },
  };
}

function foreground() {
  const listeners = new Set<() => void>();
  const fg = {
    shown: true,
    visible: () => fg.shown,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    emit: () => listeners.forEach((l) => l()),
  };
  return fg;
}

async function waitFor(cond: () => boolean, what = 'condición'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`No se cumplió: ${what}`);
}

/** Un móvil de consulta con su propia base, red y temporizadores. */
async function spectator(name: string, token = viewerTokens[0]!, role: RemoteTeam['role'] = 'viewer') {
  const account = new AccountStore(`cuenta-${n}-${name}`);
  await account.saveDevice({ deviceId: name, token, joinedAt: now().toISOString() });
  const net = network();
  const store = new ViewerStore(`consulta-${n}-${name}`);
  const viewer = new ClubViewer(net.api, account, store, now);
  const timers = manualTimers();
  const fg = foreground();
  const teams = [remoteTeam(role)];
  const feed = new LiveFeed(viewer, () => teams, { timers, now, foreground: fg });
  feeds.push(feed);
  const view = () => viewer.view(REMOTE);
  /** Espera a que termine la consulta en curso (queda programada la siguiente). */
  const settled = () => waitFor(() => feed.idle(REMOTE) && timers.queue.size === 1 && net.inFlight === 0, `${name}: consulta terminada`);
  /** Espera a que termine la consulta en curso, quede o no programada otra. */
  const idle = () => waitFor(() => feed.idle(REMOTE) && net.inFlight === 0, `${name}: sin consulta en curso`);
  /** Siguiente consulta del directo. */
  const tick = async () => {
    const waits = timers.fire();
    await settled();
    return waits;
  };
  const score = (matchId = match.id) => {
    const snap = view().cached!.snapshot;
    const m = snap.matches.find((x) => x.match.id === matchId)!.match;
    return computeMatchStats(m, snap.events.map((e) => e.event).filter((e) => e.matchId === matchId)).score;
  };
  return { name, net, store, viewer, timers, fg, teams, feed, view, settled, idle, tick, score };
}

/** El iPhone registra y envía (como hace su envío automático). */
async function record(payload: Parameters<typeof svc.recordEvent>[2], playerIndex: number | null = 0) {
  const e = await svc.recordEvent(local, match, payload, playerIndex === null ? null : ids[playerIndex]!, { period: 1, matchTimeMs: 60_000 });
  expect((await iphone.upload(localTeam.id)).status).toBe('verified');
  return e;
}

const goal = { kind: 'shot', shotType: 'six_m', result: 'goal' } as const;

function serverDump(): string {
  const tables = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return JSON.stringify(Object.fromEntries(tables.map((t) => [t, db.sqlite.prepare(`SELECT * FROM ${t}`).all()])));
}

beforeEach(async () => {
  n++;
  db = migratedDb();
  addClub(db, 'A');
  addTeam(db, REMOTE, 'A', 'SMA2627');
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://develop.galipau-stats.pages.dev' };
  const coach = (await addDevice(db, 'iphone', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token;
  viewerTokens = [];
  for (const id of ['familia-1', 'familia-2', 'familia-3']) {
    viewerTokens.push((await addDevice(db, id, [{ clubId: 'A', teamId: REMOTE, role: 'viewer' }])).token);
  }

  local = new IndexedDbRepository(`local-${n}`);
  localTeam = await createTeam(local, { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', maxSquad: 16 });
  ids = [];
  for (const [num, pos] of [[7, 'field'], [9, 'field'], [14, 'field'], [1, 'goalkeeper']] as const) {
    ids.push((await savePlayer(local, localTeam.id, { name: `Jugador ${num}`, number: num, position: pos, active: true })).id);
  }
  match = await svc.createMatch(local, { teamId: localTeam.id, opponent: 'BM Rival', date: '2026-10-31', venue: 'home', season: '2026/27', playerIds: ids });
  match = await svc.toggleClock(local, match, clock); // partido en curso
  await svc.recordEvent(local, match, goal, ids[0]!, { period: 1, matchTimeMs: 0 });
  const account = new AccountStore(`cuenta-${n}-iphone`);
  await account.saveDevice({ deviceId: 'iphone', token: coach, joinedAt: now().toISOString() });
  coachNet = network();
  iphone = new ClubSync(local, account, coachNet.api, () => [remoteTeam('coach')], now);
  await iphone.link(localTeam.id, REMOTE);
  expect((await iphone.upload(localTeam.id)).status).toBe('verified');
});

afterEach(() => {
  for (const f of feeds.splice(0)) f.dispose();
});

describe('actualización en directo de la consulta', () => {
  it('un gol aparece en otro móvil sin cambiar de pantalla, pidiendo solo los cambios', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    expect(s.view().live).toBe('live');
    expect(s.score().own).toBe(1);
    expect(s.net.requests).toEqual([`GET /api/teams/${REMOTE}/snapshot`]); // primera vez: equipo completo

    await record(goal, 1);
    s.net.requests.length = 0;
    expect(await s.tick()).toEqual([5_000]);
    expect(s.score().own).toBe(2);
    expect(s.view().live).toBe('live');
    expect(s.net.requests).toHaveLength(1);
    expect(s.net.requests[0]).toMatch(/^GET \/api\/teams\/remoto-sma\/changes\?since=\d+$/);
  });

  it('paradas, sanciones, goles y rankings: idénticos a los del iPhone tras cada consulta', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    await record({ kind: 'gk_shot', shotType: 'nine_m', result: 'save' }, 3);
    await record({ kind: 'exclusion' }, 2);
    await record(goal, 2);
    const undone = await record(goal, 1);
    await svc.deleteEvent(local, undone);
    expect((await iphone.upload(localTeam.id)).status).toBe('verified');
    await s.tick();

    const localItems = await loadSeasonItems(local, localTeam.id);
    const remoteItems = seasonItems(s.view().cached!.snapshot);
    const json = (st: ReturnType<typeof computeSeasonStats>) => stableJson({ ...st, players: [...st.players.entries()].sort() });
    expect(json(computeSeasonStats(remoteItems))).toBe(json(computeSeasonStats(localItems)));
    const localEvents = (await local.listEvents(match.id)).filter((e) => e.deletedAt === null);
    expect(stableJson(computeMatchStats(remoteItems[0]!.match, remoteItems[0]!.events))).toBe(stableJson(computeMatchStats(match, localEvents)));
    for (const def of RANKINGS) {
      const r = (items: typeof localItems) => rankPlayers(def, seasonCandidates(computeSeasonStats(items))).map((e) => [e.position, e.player.playerId, e.value]);
      expect(r(remoteItems), def.id).toEqual(r(localItems));
    }
    expect(s.score().own).toBe(2);
  });

  it('cambios del partido (cronómetro, corrección de marcador, borrado): se descarga el equipo y se ven', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    match = await svc.setScoreAdjustment(local, match, { own: 3, opponent: 1 });
    expect((await iphone.upload(localTeam.id)).status).toBe('verified');
    s.net.requests.length = 0;
    await s.tick();
    expect(s.net.requests.map((r) => r.split('?')[0])).toEqual([`GET /api/teams/${REMOTE}/changes`, `GET /api/teams/${REMOTE}/snapshot`]);
    expect(s.score()).toMatchObject({ own: 4, opponent: 1 });
    await svc.deleteMatch(local, match);
    expect((await iphone.upload(localTeam.id)).status).toBe('verified');
    await s.tick();
    expect(seasonItems(s.view().cached!.snapshot)).toHaveLength(0);
  });

  it('consultas sin cambios: respuesta vacía, sin descargas ni cambios en los datos mostrados', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    const shown = s.view().cached;
    s.net.requests.length = 0;
    for (let i = 0; i < 5; i++) {
      clock += 5_000;
      await s.tick();
      expect(s.view().checkedAt).toBe(now().toISOString()); // la hora de la última confirmación avanza
    }
    expect(s.net.requests).toHaveLength(5);
    expect(s.net.requests.every((r) => r.includes('/changes?since='))).toBe(true);
    expect(s.view().cached).toBe(shown); // mismos datos: nada que volver a pintar
    expect(s.view().live).toBe('live');
  });

  it('cambiar de pantalla dentro del equipo no reinicia nada ni descarga de nuevo', async () => {
    const s = await spectator('familia');
    const stopList = s.feed.watch(REMOTE);
    await s.settled();
    s.net.requests.length = 0;
    // Lista → partido: una pantalla deja de seguir el equipo y la otra lo sigue.
    stopList();
    const stopMatch = s.feed.watch(REMOTE);
    expect(s.view().live).toBe('live');
    expect(s.net.requests).toHaveLength(0); // la consulta recién hecha no se repite
    expect(s.feed.scheduled(REMOTE)).toBe(true);
    await s.tick();
    expect(s.net.requests).toHaveLength(1);
    expect(s.net.requests[0]).toMatch(/\/changes\?/);
    stopMatch();
    expect(s.feed.watching()).toEqual([]);
    expect(s.timers.queue.size).toBe(0); // sin pantalla de consulta abierta, no se consulta
  });

  it('sin conexión: conserva los datos, esperas crecientes sin ráfagas y se recupera solo', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    s.net.down = true;
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) waits.push(...(await s.tick()));
    expect(waits).toEqual([5_000, 5_000, 10_000, 20_000, 40_000, 60_000]);
    expect(s.timers.queue.values().next().value!.ms).toBe(60_000);
    expect(s.view().live).toBe('offline');
    expect(s.score().own).toBe(1); // lo último descargado sigue a la vista
    expect(s.net.requests.filter((r) => r.includes('/changes')).length).toBe(6);

    await record(goal, 1);
    s.net.down = false;
    s.fg.emit(); // «online»: se consulta en el momento
    await s.settled();
    expect(s.view().live).toBe('live');
    expect(s.score().own).toBe(2);
    expect(await s.tick()).toEqual([5_000]);
  });

  it('servidor caído un rato: «Actualizando…» y, pasado un tiempo, «Datos desactualizados»', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    const before = env.DB;
    env.DB = { prepare: () => { throw new Error('caído'); }, batch: () => { throw new Error('caído'); } } as unknown as Env['DB'];
    clock += 5_000;
    await s.tick();
    expect(s.view().live).toBe('retrying');
    clock += 30_000;
    await s.tick();
    expect(s.view().live).toBe('stale');
    expect(s.view().checkedAt).toBe(new Date(clock - 35_000).toISOString()); // la hora no avanza sin datos nuevos
    env.DB = before;
    await s.tick();
    expect(s.view().live).toBe('live');
  });

  it('app oculta: no consulta; al volver, consulta en el momento', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    s.fg.shown = false;
    s.fg.emit();
    expect(s.timers.queue.size).toBe(0);
    expect(s.view().live).toBe('checking'); // no se presenta como al día lo que no se ha comprobado
    const sent = s.net.requests.length;
    await record(goal, 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.net.requests.length).toBe(sent);

    s.fg.shown = true;
    s.fg.emit();
    await s.settled();
    expect(s.net.requests.length).toBe(sent + 1);
    expect(s.score().own).toBe(2);
    expect(s.view().live).toBe('live');
  });

  it('nunca dos consultas a la vez: «Actualizar» durante una consulta espera su turno', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    s.net.delayMs = 40;
    await record(goal, 1);
    s.timers.fire();
    const manual = s.feed.refreshNow(REMOTE);
    await manual;
    await s.settled();
    expect(s.net.maxInFlight).toBe(1);
    expect(s.score().own).toBe(2);
  });

  it('respuestas antiguas: nunca sustituyen datos más recientes', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    // Una descarga completa que llega tarde, con datos de antes del último gol.
    const old = await s.net.api.snapshot(viewerTokens[0]!, REMOTE);
    await record(goal, 1);
    await s.tick();
    expect(s.score().own).toBe(2);
    const slow: Api = { ...s.net.api, snapshot: async () => old };
    const lagging = new ClubViewer(slow, new AccountStore(`cuenta-${n}-familia`), s.store, now);
    await lagging.load(REMOTE);
    await lagging.refresh(remoteTeam());
    expect(computeMatchStats(match, lagging.view(REMOTE).cached!.snapshot.events.map((e) => e.event)).score.own).toBe(2);
    expect((await s.store.get(REMOTE))!.snapshot.seq).toBeGreaterThan(old.seq);
  });

  it('si se retira el equipo mientras llega una respuesta, no vuelve a aparecer', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    await record(goal, 1);
    s.net.delayMs = 40;
    s.timers.fire();
    await new Promise((r) => setTimeout(r, 10));
    await s.viewer.forget(REMOTE); // p. ej. «Salir de este equipo»
    await waitFor(() => s.net.inFlight === 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.view().cached).toBeNull();
    expect(await s.store.get(REMOTE)).toBeNull();
  });

  it('acceso retirado en el servidor: se borran los datos de consulta y se deja de consultar', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    db.sqlite.prepare("UPDATE grants SET revoked_at = '2026-10-31T18:10:00.000Z' WHERE device_id = 'familia-1'").run();
    s.timers.fire();
    await waitFor(() => s.net.inFlight === 0 && s.view().cached === null);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.view().problem).toBe('no_access');
    expect(await s.store.get(REMOTE)).toBeNull();
    expect(s.timers.queue.size).toBe(0);
    expect(s.feed.watching()).toEqual([]);
    // Los datos del registrador no se tocan.
    expect((await local.listEvents(match.id)).length).toBe(1);
  });

  it('varios espectadores a la vez ven lo mismo y la consulta no escribe nada en el servidor', async () => {
    const all = [await spectator('familia-a', viewerTokens[0]), await spectator('familia-b', viewerTokens[1]), await spectator('familia-c', viewerTokens[2])];
    for (const s of all) s.feed.watch(REMOTE);
    for (const s of all) await s.settled();
    await record(goal, 1);
    await record({ kind: 'gk_shot', shotType: 'six_m', result: 'save' }, 3);
    const before = serverDump();
    for (let i = 0; i < 3; i++) for (const s of all) await s.tick();
    expect(serverDump()).toBe(before);
    for (const s of all) {
      expect(s.score().own).toBe(2);
      expect(s.view().live).toBe('live');
      expect(s.net.requests.every((r) => r.startsWith('GET '))).toBe(true);
    }
    // El iPhone sigue enviando con normalidad mientras se consulta.
    await record(goal, 2);
    for (const s of all) await s.tick();
    for (const s of all) expect(s.score().own).toBe(3);
  });
});

describe('consulta periódica solo con partidos en curso', () => {
  const finishAndSend = async () => {
    match = await svc.finishMatch(local, match, clock);
    expect((await iphone.upload(localTeam.id)).status).toBe('verified');
  };

  it('equipo sin partidos en curso: una consulta al entrar y ningún temporizador', async () => {
    await finishAndSend();
    const s = await spectator('familia');
    const stop = s.feed.watch(REMOTE);
    await s.idle();
    expect(s.net.requests).toHaveLength(1);
    expect(s.feed.scheduled(REMOTE)).toBe(false);
    expect(s.timers.queue.size).toBe(0);
    expect(s.view().live).toBeNull(); // sin «En directo»: solo la hora de los datos
    expect(s.view().cached).not.toBeNull();
    // Volver a entrar más tarde: otra consulta puntual, sin seguimiento.
    stop();
    clock += 60_000;
    s.feed.watch(REMOTE);
    await s.idle();
    expect(s.net.requests).toHaveLength(2);
    expect(s.timers.queue.size).toBe(0);
  });

  it('partido nuevo con la pantalla abierta: se descubre con «Actualizar» y entonces se sigue', async () => {
    await finishAndSend();
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.idle();
    const other = await svc.createMatch(local, { teamId: localTeam.id, opponent: 'CH Segundo', date: '2026-11-01', venue: 'away', season: '2026/27', playerIds: ids });
    await svc.toggleClock(local, other, clock);
    expect((await iphone.upload(localTeam.id)).status).toBe('verified');
    await new Promise((r) => setTimeout(r, 30));
    expect(s.net.requests).toHaveLength(1); // nadie lo busca solo
    await s.feed.refreshNow(REMOTE);
    expect(s.view().live).toBe('live');
    expect(s.feed.scheduled(REMOTE)).toBe(true);
  });

  it('partido en curso: «En directo» y consulta cada 5 s', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    expect(s.view().live).toBe('live');
    expect([...s.timers.queue.values()].map((t) => t.ms)).toEqual([5_000]);
  });

  it('fin del último partido: se aplican los datos definitivos y, tras las consultas de cierre, se para', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    // Último gol y final: la finalización llega al servidor antes que el gol.
    await svc.recordEvent(local, match, goal, ids[1]!, { period: 2, matchTimeMs: 3_595_000 });
    match = await svc.finishMatch(local, match, clock);
    let release!: () => void;
    coachNet.hold = new Promise((r) => (release = r));
    const sending = iphone.upload(localTeam.id);
    await waitFor(() => (db.sqlite.prepare('SELECT status FROM matches').get() as { status: string }).status === 'finished', 'finalización en el servidor');
    await s.tick();
    expect(s.view().cached!.snapshot.matches[0]!.match.status).toBe('finished');
    expect(s.view().live).toBeNull(); // ya no hay partido en curso
    expect(s.score().own).toBe(1); // el gol aún no ha llegado
    coachNet.hold = null;
    release();
    expect((await sending).status).toBe('verified');
    await s.tick();
    expect(s.score().own).toBe(2); // datos definitivos
    const before = s.net.requests.length;
    s.timers.fire();
    await s.idle();
    expect(s.timers.queue.size).toBe(0); // parada
    expect(s.net.requests.length - before).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.net.requests.length - before).toBe(1);
  });

  it('varios partidos: mientras quede uno en curso se sigue consultando', async () => {
    const other = await svc.createMatch(local, { teamId: localTeam.id, opponent: 'CH Segundo', date: '2026-10-31', venue: 'away', season: '2026/27', playerIds: ids });
    await svc.toggleClock(local, other, clock);
    expect((await iphone.upload(localTeam.id)).status).toBe('verified');
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    await finishAndSend();
    for (let i = 0; i < 5; i++) await s.tick();
    expect(s.view().live).toBe('live');
    expect(s.feed.scheduled(REMOTE)).toBe(true);
  });

  it('pantalla oculta: sin temporizador; al volver se comprueba una vez antes de seguir', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    s.fg.shown = false;
    s.fg.emit();
    expect(s.feed.scheduled(REMOTE)).toBe(false);
    await finishAndSend();
    s.fg.shown = true;
    s.fg.emit();
    await s.idle();
    // El partido terminó mientras tanto: datos definitivos y nada de «En directo».
    expect(s.view().cached!.snapshot.matches[0]!.match.status).toBe('finished');
    expect(s.view().live).toBeNull();
  });

  it('límite de 120 min: se pausa sin reiniciarse por los goles, no se reanuda al volver y sí a mano', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    clock += 60 * 60_000;
    await record(goal, 1); // un gol no reinicia las 2 h
    await s.tick();
    expect(s.view().live).toBe('live');
    clock += 60 * 60_000;
    s.timers.fire();
    await s.idle();
    expect(s.view().live).toBe('paused');
    expect(s.feed.scheduled(REMOTE)).toBe(false);
    expect(s.score().own).toBe(2); // lo último recibido sigue a la vista

    const sent = s.net.requests.length;
    s.fg.shown = false;
    s.fg.emit();
    s.fg.shown = true;
    s.fg.emit();
    await new Promise((r) => setTimeout(r, 30));
    expect(s.net.requests.length).toBe(sent);
    expect(s.view().live).toBe('paused');

    s.feed.resume(REMOTE);
    await s.settled();
    expect(s.net.requests.length).toBe(sent + 1);
    expect(s.view().live).toBe('live');
  });

  it('reanudar sin partido en curso: comprueba una vez y no sigue', async () => {
    const s = await spectator('familia');
    s.feed.watch(REMOTE);
    await s.settled();
    clock += 120 * 60_000;
    s.timers.fire();
    await s.idle();
    expect(s.view().live).toBe('paused');
    await finishAndSend();
    s.feed.resume(REMOTE);
    await s.idle();
    expect(s.view().live).toBeNull();
    expect(s.feed.scheduled(REMOTE)).toBe(false);
  });

  it('una respuesta retrasada no reactiva una consulta ya detenida', async () => {
    const s = await spectator('familia');
    const stop = s.feed.watch(REMOTE);
    await s.settled();
    s.net.delayMs = 40;
    s.timers.fire(); // consulta en vuelo
    await new Promise((r) => setTimeout(r, 5));
    stop(); // se cierra la pantalla
    await waitFor(() => s.net.inFlight === 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.timers.queue.size).toBe(0);
    expect(s.view().live).toBeNull();
  });

  it('sin conexión al entrar y sin partido en curso: no reintenta solo; al volver la conexión, una consulta', async () => {
    await finishAndSend();
    const s = await spectator('familia');
    s.net.down = true;
    s.feed.watch(REMOTE);
    await s.idle();
    expect(s.view().live).toBe('offline');
    expect(s.timers.queue.size).toBe(0);
    s.net.down = false;
    s.fg.emit(); // «online»
    await s.idle();
    expect(s.view().cached).not.toBeNull();
    expect(s.view().live).toBeNull();
    expect(s.timers.queue.size).toBe(0);
  });
});

describe('respuestas tardías tras retirar los datos', () => {
  /** Base de consulta con lecturas y escrituras lentas (para provocar las carreras). */
  class SlowStore extends ViewerStore {
    getMs = 0;
    putMs = 0;
    override async get(teamId: string) {
      if (this.getMs) await new Promise((r) => setTimeout(r, this.getMs));
      return super.get(teamId);
    }
    override async put(team: Parameters<ViewerStore['put']>[0]) {
      if (this.putMs) await new Promise((r) => setTimeout(r, this.putMs));
      return super.put(team);
    }
  }

  async function device(name: string) {
    const account = new AccountStore(`cuenta-${n}-${name}`);
    await account.saveDevice({ deviceId: name, token: viewerTokens[0]!, joinedAt: now().toISOString() });
    const net = network();
    const store = new SlowStore(`consulta-${n}-${name}`);
    const viewer = new ClubViewer(net.api, account, store, now);
    return { account, net, store, viewer };
  }

  const gone = async (d: Awaited<ReturnType<typeof device>>) => {
    expect(d.viewer.view(REMOTE).cached).toBeNull();
    expect(await d.store.get(REMOTE)).toBeNull();
  };

  it('«Salir» mientras se lee lo guardado: la consulta no lo recupera', async () => {
    const d = await device('familia');
    await d.viewer.refresh(remoteTeam());
    // Otra sesión de la app: aún no hay nada en memoria, solo en la base.
    const again = new ClubViewer(d.net.api, d.account, d.store, now);
    d.store.getMs = 30;
    const polling = again.poll(remoteTeam());
    await new Promise((r) => setTimeout(r, 5));
    await again.forget(REMOTE);
    d.store.getMs = 0;
    await polling;
    expect(again.view(REMOTE).cached).toBeNull();
    expect(await d.store.get(REMOTE)).toBeNull();
  });

  it('sesión cerrada con una descarga completa en vuelo: no vuelve a aparecer', async () => {
    const d = await device('familia');
    d.net.delayMs = 40;
    const downloading = d.viewer.refresh(remoteTeam());
    await new Promise((r) => setTimeout(r, 10));
    await d.account.clear();
    await d.viewer.keepOnly([]); // lo que hace la app al cerrarse la sesión
    await downloading;
    await new Promise((r) => setTimeout(r, 20));
    await gone(d);
  });

  it('acceso retirado mientras se guarda una descarga: se borra igualmente', async () => {
    const d = await device('familia');
    d.store.putMs = 40;
    const downloading = d.viewer.refresh(remoteTeam());
    await waitFor(() => d.net.inFlight === 0 && d.net.requests.length === 1, 'respuesta recibida');
    // Aún no está guardado: la comprobación de la sesión ya no incluye el equipo.
    await d.viewer.keepOnly([]);
    await downloading;
    await new Promise((r) => setTimeout(r, 60));
    await gone(d);
  });

  it('consultas en cola de antes de retirar el equipo: no hacen nada', async () => {
    const d = await device('familia');
    await d.viewer.refresh(remoteTeam());
    d.net.delayMs = 40;
    const first = d.viewer.poll(remoteTeam());
    const queued = d.viewer.refresh(remoteTeam());
    await new Promise((r) => setTimeout(r, 10));
    db.sqlite.prepare("UPDATE grants SET revoked_at = '2026-10-31T18:10:00.000Z' WHERE device_id = 'familia-1'").run();
    await d.viewer.forget(REMOTE);
    const sent = d.net.requests.length;
    await Promise.all([first, queued]);
    await new Promise((r) => setTimeout(r, 20));
    expect(d.net.requests.length).toBe(sent); // la de la cola ni siquiera se envía
    await gone(d);
  });

  it('respuesta de error tardía tras retirar: no muestra avisos de un equipo retirado', async () => {
    const d = await device('familia');
    await d.viewer.refresh(remoteTeam());
    d.net.delayMs = 30;
    const before = env.DB;
    env.DB = { prepare: () => { throw new Error('caído'); }, batch: () => { throw new Error('caído'); } } as unknown as Env['DB'];
    const polling = d.viewer.poll(remoteTeam());
    await new Promise((r) => setTimeout(r, 5));
    await d.viewer.forget(REMOTE);
    await polling;
    env.DB = before;
    expect(d.viewer.view(REMOTE).problem).toBeNull();
    await gone(d);
  });
});
