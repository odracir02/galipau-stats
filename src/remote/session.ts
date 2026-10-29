// Sesión del dispositivo con el servidor: unirse a un equipo con un código,
// comprobar los permisos vigentes, salir de un equipo y cerrar la sesión.
//
// Los permisos los decide siempre el servidor; aquí solo se guardan para
// mostrarlos (también sin conexión). Nada de esto toca los equipos ni los
// partidos guardados en el dispositivo, ni sube o descarga datos de partidos.
import { CODE_LENGTH, isTransient, normalizeCode, RemoteError, type Api, type RemoteRole, type RemoteTeam } from './api';
import type { AccountStore } from './store';

export interface RemoteState {
  /** Ya se ha leído la sesión guardada. */
  ready: boolean;
  /** El dispositivo tiene una credencial guardada. */
  linked: boolean;
  /** El servidor ha rechazado la credencial (sesión cerrada o retirada en otro sitio). */
  revoked: boolean;
  teams: RemoteTeam[];
  /** Última comprobación correcta con el servidor (ISO). */
  checkedAt: string | null;
  /** Comprobación en curso. */
  checking: boolean;
  /** Problema de la última comprobación; los equipos mostrados son los guardados. */
  problem: 'offline' | 'server' | null;
}

export interface JoinResult {
  teamId: string;
  role: RemoteRole;
  teamName: string;
  clubName: string;
  season: string;
}

const INITIAL: RemoteState = {
  ready: false,
  linked: false,
  revoked: false,
  teams: [],
  checkedAt: null,
  checking: false,
  problem: null,
};

export const ROLE_LABEL: Record<RemoteRole, string> = { coach: 'Entrenador', viewer: 'Consulta' };

/** Fecha y hora local de una comprobación (ISO), p. ej. «29/10, 14:05». */
export function formatChecked(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Nombre genérico del dispositivo, para reconocerlo en el panel. Nunca datos personales. */
export function deviceLabel(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/iPhone/i.test(userAgent)) return 'iPhone';
  if (/iPad/i.test(userAgent)) return 'iPad';
  if (/Android/i.test(userAgent)) return 'Android';
  return 'Ordenador';
}

export interface SessionOptions {
  /** Esperas entre reintentos de la comprobación (ms). */
  retryDelays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  label?: () => string;
}

export class RemoteSession {
  private state: RemoteState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly loaded: Promise<void>;
  private refreshing: Promise<void> | null = null;
  private readonly retryDelays: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly label: () => string;

  constructor(
    private readonly api: Api,
    private readonly store: AccountStore,
    options: SessionOptions = {},
  ) {
    this.retryDelays = options.retryDelays ?? [500, 1500];
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => new Date());
    this.label = options.label ?? (() => deviceLabel());
    this.loaded = this.load();
  }

  // --- Estado observable (para useSyncExternalStore) -------------------------

  getState = (): RemoteState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<RemoteState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private async load(): Promise<void> {
    const [device, teams] = await Promise.all([this.store.getDevice(), this.store.getTeams()]);
    this.set({ ready: true, linked: device !== null, teams: teams?.teams ?? [], checkedAt: teams?.checkedAt ?? null });
  }

  /** Espera a que se haya leído la sesión guardada. */
  whenReady(): Promise<void> {
    return this.loaded;
  }

  // --- Operaciones -----------------------------------------------------------

  /**
   * Canjea un código. El rol lo decide el servidor. Si el dispositivo ya tiene
   * sesión, el equipo se añade a ella; si su credencial ya no vale, se crea una
   * nueva. No se reintenta solo: un canje repetido sin respuesta podría crear
   * otro dispositivo, así que el usuario decide si vuelve a probar.
   */
  async join(rawCode: string): Promise<JoinResult> {
    await this.loaded;
    const code = normalizeCode(rawCode);
    if (code.length !== CODE_LENGTH) {
      throw new RemoteError('invalid_code', `El código tiene ${CODE_LENGTH} letras o números (por ejemplo, ABCD-EFGH-JKLM).`);
    }
    const device = await this.store.getDevice();
    let result;
    try {
      result = await this.api.redeem(code, device?.token ?? null, this.label());
    } catch (e) {
      // Credencial guardada revocada: se olvida y se canjea como dispositivo nuevo.
      // El servidor rechaza la credencial antes de contar el intento, así que no hay doble canje.
      if (!(e instanceof RemoteError && e.kind === 'unauthorized' && device)) throw e;
      await this.store.clear();
      this.set({ linked: false, teams: [], checkedAt: null });
      result = await this.api.redeem(code, null, this.label());
    }
    if (result.token) {
      await this.store.saveDevice({ deviceId: result.deviceId, token: result.token, joinedAt: this.now().toISOString() });
    }
    // Hasta confirmar con el servidor, se muestra el equipo devuelto por el canje.
    const joined: RemoteTeam = {
      teamId: result.team.id,
      role: result.role,
      status: 'active',
      name: result.team.name,
      code: result.team.code,
      season: result.team.season,
      clubId: result.team.clubId,
      clubName: result.team.clubName,
    };
    const others = this.state.teams.filter((t) => t.teamId !== joined.teamId);
    await this.store.saveTeams({ teams: [...others, joined], checkedAt: this.state.checkedAt ?? this.now().toISOString() });
    this.set({ linked: true, revoked: false, teams: [...others, joined] });
    await this.refresh().catch(() => undefined);
    return {
      teamId: result.team.id,
      role: result.role,
      teamName: result.team.name,
      clubName: result.team.clubName,
      season: result.team.season,
    };
  }

  /**
   * Comprueba con el servidor los equipos y permisos vigentes. Reintenta los
   * fallos de red o del servidor; sin conexión se siguen mostrando los últimos
   * equipos conocidos. Si el servidor rechaza la credencial, se olvida (los
   * datos del dispositivo no se tocan).
   */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    await this.loaded;
    const device = await this.store.getDevice();
    if (!device) return;
    this.set({ checking: true });
    for (let attempt = 0; ; attempt++) {
      try {
        const session = await this.api.getSession(device.token);
        const checkedAt = this.now().toISOString();
        await this.store.saveTeams({ teams: session.teams, checkedAt });
        this.set({ checking: false, problem: null, revoked: false, linked: true, teams: session.teams, checkedAt });
        return;
      } catch (e) {
        if (e instanceof RemoteError && e.kind === 'unauthorized') {
          await this.store.clear();
          this.set({ checking: false, problem: null, revoked: true, linked: false, teams: [], checkedAt: null });
          return;
        }
        const delay = this.retryDelays[attempt];
        if (isTransient(e) && delay !== undefined) {
          await this.sleep(delay);
          continue;
        }
        const offline = e instanceof RemoteError && (e.kind === 'offline' || e.kind === 'timeout');
        this.set({ checking: false, problem: offline ? 'offline' : 'server' });
        return;
      }
    }
  }

  /** Deja un equipo (retira el permiso de este dispositivo). Necesita conexión. */
  async leave(teamId: string): Promise<void> {
    const device = await this.requireDevice();
    try {
      await this.api.leaveTeam(device.token, teamId);
    } catch (e) {
      // Si el servidor ya no tiene ese permiso, el resultado es el mismo.
      if (!(e instanceof RemoteError && e.kind === 'not_found')) throw e;
    }
    const teams = this.state.teams.filter((t) => t.teamId !== teamId);
    await this.store.saveTeams({ teams, checkedAt: this.now().toISOString() });
    this.set({ teams });
    await this.refresh().catch(() => undefined);
  }

  /**
   * Cierra la sesión: el servidor revoca la credencial y todos los permisos de
   * este dispositivo. Necesita conexión para que la revocación sea real.
   */
  async logout(): Promise<void> {
    const device = await this.requireDevice();
    try {
      await this.api.logout(device.token);
    } catch (e) {
      // Ya revocada en el servidor: basta con olvidarla aquí.
      if (!(e instanceof RemoteError && e.kind === 'unauthorized')) throw e;
    }
    await this.store.clear();
    this.set({ linked: false, revoked: false, teams: [], checkedAt: null, problem: null });
  }

  /** Tras avisar de una sesión retirada, vuelve al estado normal. */
  dismissRevoked(): void {
    this.set({ revoked: false });
  }

  private async requireDevice() {
    await this.loaded;
    const device = await this.store.getDevice();
    if (!device) throw new RemoteError('unauthorized', 'Este dispositivo no tiene sesión.');
    return device;
  }
}
