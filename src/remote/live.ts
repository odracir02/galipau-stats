// Actualización en directo de los equipos del club que se están consultando.
//
// * Al abrir una pantalla de consulta (o al volver a la app) se consulta UNA vez
//   el estado. Solo si el equipo tiene un partido en curso (o en el descanso) se
//   sigue consultando cada 5 s; sin partidos en curso no queda ningún
//   temporizador: un partido nuevo se descubre al volver a entrar o con
//   «Actualizar».
// * Cuando termina el último partido en curso, se aplican sus datos definitivos
//   y se hacen unas pocas consultas de cierre (por si sus últimas acciones llegan
//   justo después de la finalización); después se deja de consultar.
// * Seguimiento continuo de 2 h como máximo: después se pausa hasta que el
//   usuario pulse «Reanudar directo» (un partido olvidado en curso no consulta
//   toda la noche). Volver a la app no reanuda una pausa.
// * Cada consulta pide solo los cambios posteriores a lo descargado (ver
//   ClubViewer.poll). En segundo plano no se consulta. Una consulta a la vez
//   por equipo; tras un error, esperas crecientes. Si el servidor retira el
//   acceso, se deja de consultar.
// * Solo lectura: nunca escribe en el servidor.
import type { RemoteTeam, TeamSnapshot } from './api';
import type { Timers } from './autosync';
import type { ClubViewer, FetchResult } from './viewer';

/** Cuándo se puede consultar: app visible. Se avisa al volver o al recuperar la conexión. */
export interface Foreground {
  visible: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

export interface LiveFeedOptions {
  intervalMs?: number;
  /** Esperas tras errores consecutivos (solo mientras se sigue un partido). */
  retryMs?: readonly number[];
  /** Sin poder actualizar durante este tiempo, los datos se dan por desactualizados. */
  staleMs?: number;
  /** Máximo de seguimiento continuo antes de pausarlo. */
  maxFollowMs?: number;
  /** Consultas tras terminar el último partido en curso, antes de parar. */
  closingChecks?: number;
  timers?: Timers;
  now?: () => Date;
  foreground?: Foreground;
}

/** Pantalla(s) de consulta abiertas de un equipo. */
interface Watch {
  count: number;
  timer: unknown;
  running: boolean;
  failures: number;
  /** Cambia al parar o pausar: una respuesta de antes ya no programa nada. */
  gen: number;
}

/** Estado del seguimiento de un equipo; se conserva al cambiar de pantalla. */
interface Follow {
  /** Inicio del seguimiento continuo (ms); null si no se está siguiendo un partido. */
  startedAt: number | null;
  /** Pausado por el límite de tiempo: solo se reanuda con «Reanudar directo». */
  paused: boolean;
  /** Consultas de cierre que quedan tras terminar el último partido en curso. */
  closing: number;
  /** Última consulta correcta (ms). */
  okAt: number | null;
}

/** Partido en juego: en curso o en el descanso (no los preparados ni los finalizados). */
export function hasLiveMatch(snapshot: TeamSnapshot | null | undefined): boolean {
  return (snapshot?.matches ?? []).some(({ match }) => match.deletedAt === null && (match.status === 'in_progress' || match.status === 'halftime'));
}

/** Visibilidad de la página y eventos del navegador que justifican consultar ya. */
export function browserForeground(): Foreground {
  return {
    visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    subscribe: (listener) => {
      const events = [
        [document, 'visibilitychange'],
        [window, 'pageshow'],
        [window, 'online'],
      ] as const;
      for (const [target, name] of events) target.addEventListener(name, listener);
      return () => {
        for (const [target, name] of events) target.removeEventListener(name, listener);
      };
    },
  };
}

export class LiveFeed {
  private readonly watches = new Map<string, Watch>();
  private readonly follows = new Map<string, Follow>();
  private readonly intervalMs: number;
  private readonly retryMs: readonly number[];
  private readonly staleMs: number;
  private readonly maxFollowMs: number;
  private readonly closingChecks: number;
  private readonly timers: Timers;
  private readonly now: () => Date;
  private readonly foreground: Foreground;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly viewer: ClubViewer,
    private readonly teams: () => RemoteTeam[],
    options: LiveFeedOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 5_000;
    this.retryMs = options.retryMs ?? [5_000, 10_000, 20_000, 40_000, 60_000];
    this.staleMs = options.staleMs ?? 30_000;
    this.maxFollowMs = options.maxFollowMs ?? 120 * 60_000;
    this.closingChecks = options.closingChecks ?? 3;
    this.timers = options.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.now = options.now ?? (() => new Date());
    this.foreground = options.foreground ?? browserForeground();
  }

  /** Empieza a seguir un equipo mientras su pantalla esté abierta. Devuelve cómo dejar de seguirlo. */
  watch(teamId: string): () => void {
    let w = this.watches.get(teamId);
    if (!w) {
      w = { count: 0, timer: null, running: false, failures: 0, gen: 0 };
      this.watches.set(teamId, w);
    }
    w.count++;
    this.unsubscribe ??= this.foreground.subscribe(this.wake);
    if (w.count === 1) this.start(teamId, w);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.release(teamId);
    };
  }

  /** «Actualizar»: descarga el equipo completo ahora. No reanuda una pausa por tiempo. */
  async refreshNow(teamId: string): Promise<void> {
    const team = this.team(teamId);
    if (!team) return;
    const w = this.watches.get(teamId);
    const gen = w?.gen;
    if (w) this.clear(w);
    const result = await this.viewer.refresh(team);
    if (!w || this.watches.get(teamId) !== w || w.gen !== gen) return;
    if (this.follow(teamId).paused) {
      if (result === 'revoked') this.after(teamId, w, result);
      else this.viewer.setLive(teamId, 'paused');
      return;
    }
    this.after(teamId, w, result);
  }

  /** «Reanudar directo» tras la pausa por tiempo: comprueba el estado y sigue solo si hay partido en curso. */
  resume(teamId: string): void {
    const f = this.follow(teamId);
    f.paused = false;
    f.startedAt = null;
    f.closing = 0;
    const w = this.watches.get(teamId);
    if (!w) return;
    w.failures = 0;
    this.check(teamId, w);
  }

  /** Equipos con pantalla de consulta abierta (para pruebas y diagnóstico). */
  watching(): string[] {
    return [...this.watches.keys()];
  }

  /** Sin consulta en curso para el equipo. */
  idle(teamId: string): boolean {
    return !this.watches.get(teamId)?.running;
  }

  /** ¿Hay un temporizador de consulta programado para el equipo? */
  scheduled(teamId: string): boolean {
    const w = this.watches.get(teamId);
    return w !== undefined && w.timer !== null;
  }

  dispose(): void {
    for (const id of [...this.watches.keys()]) this.stop(id);
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // --- Ciclo ---------------------------------------------------------------------

  private follow(teamId: string): Follow {
    let f = this.follows.get(teamId);
    if (!f) {
      f = { startedAt: null, paused: false, closing: 0, okAt: null };
      this.follows.set(teamId, f);
    }
    return f;
  }

  private following(f: Follow): boolean {
    return f.startedAt !== null;
  }

  /** Primera pantalla abierta del equipo. */
  private start(teamId: string, w: Watch): void {
    const f = this.follow(teamId);
    if (f.paused) {
      this.viewer.setLive(teamId, 'paused');
      return;
    }
    // Al pasar de una pantalla de consulta a otra no se repite una consulta recién hecha.
    if (f.okAt !== null && this.now().getTime() - f.okAt < this.intervalMs) {
      if (this.following(f)) {
        this.viewer.setLive(teamId, hasLiveMatch(this.viewer.view(teamId).cached?.snapshot) ? 'live' : null);
        this.schedule(teamId, w, this.intervalMs);
      }
      return;
    }
    this.check(teamId, w);
  }

  private release(teamId: string): void {
    const w = this.watches.get(teamId);
    if (!w) return;
    w.count--;
    if (w.count <= 0) this.stop(teamId);
  }

  private stop(teamId: string): void {
    const w = this.watches.get(teamId);
    if (w) {
      w.gen++;
      this.clear(w);
    }
    this.watches.delete(teamId);
    this.viewer.setLive(teamId, null);
    if (this.watches.size === 0) {
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
  }

  private pause(teamId: string, w: Watch): void {
    this.follow(teamId).paused = true;
    w.gen++;
    this.clear(w);
    this.viewer.setLive(teamId, 'paused');
  }

  private team(teamId: string): RemoteTeam | undefined {
    return this.teams().find((t) => t.teamId === teamId && t.status === 'active');
  }

  private clear(w: Watch): void {
    if (w.timer !== null) this.timers.clear(w.timer);
    w.timer = null;
  }

  private overLimit(f: Follow): boolean {
    return f.startedAt !== null && this.now().getTime() - f.startedAt >= this.maxFollowMs;
  }

  /** Vuelta a primer plano, recuperación de la conexión o paso a segundo plano. */
  private readonly wake = (): void => {
    for (const [teamId, w] of this.watches) {
      this.clear(w);
      const f = this.follow(teamId);
      if (!this.foreground.visible()) {
        // En segundo plano no se consulta; al volver se comprueba antes de decir «En directo».
        if (this.following(f) && !f.paused) this.viewer.setLive(teamId, 'checking');
        continue;
      }
      if (f.paused) continue; // una pausa por tiempo solo se reanuda a mano
      w.failures = 0;
      this.check(teamId, w);
    }
  };

  /** Una consulta. Lo que pase después lo decide `after`. */
  private check(teamId: string, w: Watch): void {
    if (this.watches.get(teamId) !== w || w.running || !this.foreground.visible()) return;
    const f = this.follow(teamId);
    if (f.paused) return;
    if (this.overLimit(f)) {
      this.pause(teamId, w);
      return;
    }
    const team = this.team(teamId);
    if (!team) {
      this.viewer.setLive(teamId, null);
      return;
    }
    if (this.viewer.view(teamId).live !== 'live') this.viewer.setLive(teamId, 'checking');
    const gen = w.gen;
    w.running = true;
    void this.viewer
      .poll(team)
      .catch((): FetchResult => 'error')
      .then((result) => {
        w.running = false;
        // Pantalla cerrada, pausa o parada mientras tanto: los datos ya se han
        // aplicado, pero esta respuesta no vuelve a programar nada.
        if (this.watches.get(teamId) === w && w.gen === gen) this.after(teamId, w, result);
      });
  }

  private after(teamId: string, w: Watch, result: FetchResult): void {
    const f = this.follow(teamId);
    const nowMs = this.now().getTime();
    if (result === 'revoked') {
      // El servidor ha retirado el acceso: los datos ya se han borrado; no se insiste.
      this.follows.delete(teamId);
      this.stop(teamId);
      return;
    }
    if (result === 'ok') {
      w.failures = 0;
      f.okAt = nowMs;
      if (hasLiveMatch(this.viewer.view(teamId).cached?.snapshot)) {
        f.startedAt ??= nowMs;
        f.closing = this.closingChecks;
        if (this.overLimit(f)) return this.pause(teamId, w);
        this.viewer.setLive(teamId, 'live');
        this.schedule(teamId, w, this.intervalMs);
      } else if (this.following(f) && --f.closing > 0) {
        // Último partido terminado: ya se muestran sus datos definitivos; unas
        // pocas consultas más recogen lo que se envió justo después.
        this.viewer.setLive(teamId, null);
        this.schedule(teamId, w, this.intervalMs);
      } else {
        f.startedAt = null;
        f.closing = 0;
        this.viewer.setLive(teamId, null);
      }
      return;
    }
    // Error: sin partido que seguir no se reintenta solo (al volver a la app o
    // recuperar la conexión se consulta otra vez).
    w.failures++;
    if (!this.following(f)) {
      this.viewer.setLive(teamId, result === 'offline' ? 'offline' : null);
      return;
    }
    if (this.overLimit(f)) return this.pause(teamId, w);
    const v = this.viewer.view(teamId);
    const since = f.okAt ?? Date.parse(v.checkedAt ?? v.cached?.fetchedAt ?? '');
    const stale = !Number.isFinite(since) || nowMs - since >= this.staleMs;
    this.viewer.setLive(teamId, result === 'offline' ? 'offline' : stale ? 'stale' : 'retrying');
    this.schedule(teamId, w, this.retryMs[Math.min(w.failures - 1, this.retryMs.length - 1)] ?? 60_000);
  }

  private schedule(teamId: string, w: Watch, ms: number): void {
    this.clear(w);
    if (!this.foreground.visible()) return;
    w.timer = this.timers.set(() => {
      w.timer = null;
      this.check(teamId, w);
    }, ms);
  }
}
