// «Mi jugador»: el jugador que sigue este dispositivo en cada equipo del club
// que consulta. Es una preferencia local (localStorage), una por equipo, con
// solo el identificador del jugador o la marca «Ahora no»: ni nombres, ni
// dorsales, ni datos de la sesión. Nunca se envía al servidor ni se sincroniza.
//
// Se olvida al salir del equipo o cuando el servidor confirma que ya no hay
// acceso; nunca por estar sin conexión, por un error del servidor o por una
// versión de la aplicación que hay que actualizar.
import type { RemoteState } from '../remote/session';
import type { TeamView } from '../remote/viewer';

export type MyPlayerPreference = { playerId: string } | { skipped: true };

const PREFIX = 'galipaustats.miJugador.';
const keyOf = (teamId: string) => `${PREFIX}${teamId}`;

/** Lo guardado, si es válido; cualquier otra cosa (antigua, incompleta, manipulada) es «sin preferencia». */
function parse(raw: string | null): MyPlayerPreference | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const { playerId, skipped } = v as { playerId?: unknown; skipped?: unknown };
    if (typeof playerId === 'string' && playerId.length > 0 && playerId.length <= 200) return { playerId };
    if (skipped === true) return { skipped: true };
    return null;
  } catch {
    return null;
  }
}

/** El almacenamiento del navegador, o null si no está disponible (modo privado, bloqueado…). */
function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class MyPlayerPreferences {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: () => Storage | null = browserStorage) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Preferencia de un equipo; null si no hay (o no se puede leer). */
  get(teamId: string): MyPlayerPreference | null {
    try {
      return parse(this.storage()?.getItem(keyOf(teamId)) ?? null);
    } catch {
      return null;
    }
  }

  /** Elige o cambia el jugador del equipo. Devuelve si se ha podido guardar. */
  choose(teamId: string, playerId: string): boolean {
    if (!playerId) return false;
    return this.write(teamId, JSON.stringify({ playerId }));
  }

  /** «Ahora no»: no se vuelve a preguntar en este dispositivo. */
  skip(teamId: string): boolean {
    return this.write(teamId, JSON.stringify({ skipped: true }));
  }

  /** Olvida la preferencia de un equipo (solo esa). */
  forget(teamId: string): void {
    this.write(teamId, null);
  }

  /** Olvida las de los equipos que no estén en la lista. */
  keepOnly(teamIds: readonly string[]): void {
    const allowed = new Set(teamIds);
    for (const teamId of this.teams()) if (!allowed.has(teamId)) this.forget(teamId);
  }

  /** Equipos con preferencia guardada. */
  teams(): string[] {
    try {
      const s = this.storage();
      if (!s) return [];
      const out: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (key?.startsWith(PREFIX)) out.push(key.slice(PREFIX.length));
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Sigue a la sesión. Con sesión, las preferencias de los equipos que ya no
   * están en su lista se olvidan: la lista solo cambia con una respuesta del
   * servidor (comprobación, salida del equipo), nunca sin conexión ni ante un
   * error. Un equipo con el club inactivo sigue en la lista: no es una pérdida
   * de permiso. Sin sesión (cerrada o retirada), se olvidan todas.
   */
  followSession(session: { getState: () => RemoteState; subscribe: (l: () => void) => () => void }): () => void {
    let last: string | null = null;
    const check = () => {
      const s = session.getState();
      if (!s.ready) return;
      if (s.linked && s.checkedAt === null) return;
      const teamIds = s.linked ? s.teams.map((t) => t.teamId) : [];
      const now = teamIds.slice().sort().join('\n') + (s.linked ? '' : '\n-');
      if (now === last) return;
      last = now;
      this.keepOnly(teamIds);
    };
    check();
    return session.subscribe(check);
  }

  /**
   * Sigue a la consulta: si el servidor confirma que este dispositivo ya no
   * puede ver un equipo (credencial retirada, sin permiso, equipo inexistente),
   * su preferencia se olvida. «Sin conexión» o «el servidor no responde», no.
   */
  followViewer(viewer: { view: (teamId: string) => TeamView; subscribe: (l: () => void) => () => void }): () => void {
    const check = () => {
      for (const teamId of this.teams()) {
        const problem = viewer.view(teamId).problem;
        if (problem === 'revoked' || problem === 'no_access') this.forget(teamId);
      }
    };
    check();
    return viewer.subscribe(check);
  }

  private write(teamId: string, value: string | null): boolean {
    try {
      const s = this.storage();
      if (!s) return false;
      if (value === null) {
        if (s.getItem(keyOf(teamId)) === null) return true;
        s.removeItem(keyOf(teamId));
      } else s.setItem(keyOf(teamId), value);
    } catch {
      return false;
    }
    for (const l of this.listeners) l();
    return true;
  }
}
