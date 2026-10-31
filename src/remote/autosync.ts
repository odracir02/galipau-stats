// Envío automático e incremental desde el dispositivo que registra.
//
// * Solo equipos vinculados en los que el usuario ha ACTIVADO expresamente el
//   envío automático en este dispositivo (por defecto, desactivado), con sesión
//   y permiso de entrenador vigente. El envío manual sigue disponible.
// * Agrupa los cambios: espera a que pasen unos segundos sin cambios (o un
//   máximo desde el primero) y entonces envía SOLO lo que ha cambiado, con el
//   mismo envío idempotente que el manual. Nunca bloquea el registro.
// * El cronómetro no genera envíos por el paso del tiempo: solo cuando cambia
//   su estado guardado (pausar, reanudar, ajustar, descanso).
// * Sin conexión, los cambios siguen en el dispositivo y se reintenta al
//   recuperarla, al volver a la app y con esperas crecientes.
// * Ante un conflicto, un rechazo o la falta de permiso se DETIENE para ese
//   equipo y avisa; no se reanuda solo (un envío manual comprobado lo reanuda).
// * Mientras la app está cerrada no se envía nada: al volver a abrirla se
//   comprueba si quedaba algo pendiente.
import { RemoteError, type Api, type RemoteTeam } from './api';
import type { ClubSync } from './clubsync';
import type { AccountStore } from './store';
import { runUpload, UploadBusyError } from './upload';

export type AutoStatus = 'off' | 'synced' | 'pending' | 'sending' | 'offline' | 'attention';

export interface AutoState {
  status: AutoStatus;
  /** Motivo, si requiere atención (sin datos sensibles). */
  message: string | null;
  lastSyncedAt: string | null;
}

export const AUTO_LABEL: Record<AutoStatus, string> = {
  off: 'Envío automático desactivado',
  synced: 'Sincronizado',
  pending: 'Pendiente',
  sending: 'Pendiente',
  offline: 'Sin conexión',
  attention: 'Requiere atención',
};

const OFF: AutoState = { status: 'off', message: null, lastSyncedAt: null };

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface AutoSyncOptions {
  /** Espera sin cambios antes de enviar (agrupa ráfagas). */
  quietMs?: number;
  /** Espera máxima desde el primer cambio pendiente. */
  maxWaitMs?: number;
  /** Reintentos sin conexión o con el envío manual en curso. */
  retryMs?: readonly number[];
  timers?: Timers;
  now?: () => Date;
}

interface TeamRun {
  state: AutoState;
  timer: unknown;
  firstPendingAt: number | null;
  running: boolean;
  /** Llegaron cambios durante un envío: hay que volver a mirar al terminar. */
  again: boolean;
  retries: number;
  /** Conflictos seguidos tras recibir los cambios del club (para no insistir). */
  conflictRetries: number;
}

export class AutoSync {
  private readonly teams = new Map<string, TeamRun>();
  private disposed = false;
  /** Avisos de cambio que todavía se están programando. */
  private scheduling = 0;
  private readonly listeners = new Set<() => void>();
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly retryMs: readonly number[];
  private readonly timers: Timers;
  private readonly now: () => Date;
  private receiver: { pull(localTeamId: string): Promise<unknown> } | null = null;

  /**
   * Con recepción de cambios: ante un conflicto se reciben primero los cambios
   * del club (el registro queda apartado como conflicto) y se reintenta, en vez
   * de detener todo el envío del equipo por un solo registro.
   */
  receiveWith(receiver: { pull(localTeamId: string): Promise<unknown> }): this {
    this.receiver = receiver;
    return this;
  }

  constructor(
    private readonly clubSync: ClubSync,
    private readonly store: AccountStore,
    private readonly api: Api,
    private readonly remoteTeams: () => RemoteTeam[],
    options: AutoSyncOptions = {},
  ) {
    this.quietMs = options.quietMs ?? 3_000;
    this.maxWaitMs = options.maxWaitMs ?? 15_000;
    this.retryMs = options.retryMs ?? [15_000, 30_000, 60_000, 120_000, 300_000];
    this.timers = options.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.now = options.now ?? (() => new Date());
  }

  // --- Estado observable -------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  state = (localTeamId: string): AutoState => this.teams.get(localTeamId)?.state ?? OFF;

  /** Sin envío en curso ni espera programada para el equipo (útil para comprobar el estado). */
  idle(localTeamId: string): boolean {
    const r = this.teams.get(localTeamId);
    return this.scheduling === 0 && (!r || (!r.running && r.timer === null));
  }

  private run(localTeamId: string): TeamRun {
    let r = this.teams.get(localTeamId);
    if (!r) {
      r = { state: OFF, timer: null, firstPendingAt: null, running: false, again: false, retries: 0, conflictRetries: 0 };
      this.teams.set(localTeamId, r);
    }
    return r;
  }

  private setState(localTeamId: string, patch: Partial<AutoState>): void {
    const r = this.run(localTeamId);
    r.state = { ...r.state, ...patch };
    for (const l of this.listeners) l();
  }

  /**
   * Detiene el servicio: no programa nada más y espera a que termine el envío en
   * curso (nunca lo interrumpe a medias).
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const r of this.teams.values()) {
      if (r.timer !== null) this.timers.clear(r.timer);
      r.timer = null;
    }
    while ([...this.teams.values()].some((r) => r.running)) await new Promise((res) => setTimeout(res, 10));
  }

  // --- Disparadores ------------------------------------------------------------

  /** Un dato del equipo local ha cambiado (ya guardado): programar el envío. */
  changed(localTeamId: string | null): void {
    if (!localTeamId) return;
    void this.schedule(localTeamId, 'change');
  }

  /** Al abrir la app, volver a ella o recuperar la conexión: mirar si queda algo pendiente. */
  async checkAll(): Promise<void> {
    for (const link of await this.store.listLinks()) await this.schedule(link.localTeamId, 'check');
  }

  /**
   * Activa o desactiva el envío automático de un equipo vinculado (preferencia
   * de este dispositivo). Al desactivarlo no se cancela un envío ya en curso
   * ni se pierde nada pendiente: queda para el envío manual.
   */
  async setEnabled(localTeamId: string, enabled: boolean): Promise<void> {
    const link = await this.store.getLink(localTeamId);
    if (!link) return;
    if (enabled && (link.readOnly || link.importState === 'pending')) {
      throw new RemoteError('forbidden', 'Esta copia del club es de solo lectura en este dispositivo: no se puede activar el envío automático.');
    }
    await this.store.updateLink({ ...link, auto: enabled });
    if (enabled) await this.schedule(localTeamId, 'check');
    else this.stop(localTeamId);
  }

  private stop(localTeamId: string): void {
    const r = this.run(localTeamId);
    if (r.timer !== null) this.timers.clear(r.timer);
    r.timer = null;
    r.firstPendingAt = null;
    this.setState(localTeamId, { status: 'off', message: null });
  }

  private async schedule(localTeamId: string, why: 'change' | 'check' | 'retry'): Promise<void> {
    if (this.disposed) return;
    this.scheduling++;
    try {
      await this.scheduleNow(localTeamId, why);
    } finally {
      this.scheduling--;
    }
  }

  private async scheduleNow(localTeamId: string, why: 'change' | 'check' | 'retry'): Promise<void> {
    const link = await this.store.getLink(localTeamId);
    // Las copias del club de solo lectura nunca envían.
    if (!link || link.auto !== true || link.readOnly || link.importState === 'pending') {
      if (this.teams.has(localTeamId)) this.stop(localTeamId);
      return;
    }
    if (link.autoBlocked) {
      this.setState(localTeamId, { status: 'attention', message: link.autoBlocked });
      return;
    }
    const r = this.run(localTeamId);
    if (r.running) {
      r.again = true;
      return;
    }
    const nowMs = this.now().getTime();
    if (why === 'change') {
      r.firstPendingAt ??= nowMs;
      if (r.state.status !== 'offline') this.setState(localTeamId, { status: 'pending', message: null });
    }
    if (r.timer !== null) this.timers.clear(r.timer);
    const wait = why === 'change' ? Math.max(0, Math.min(this.quietMs, (r.firstPendingAt ?? nowMs) + this.maxWaitMs - nowMs)) : 0;
    r.timer = this.timers.set(() => {
      r.timer = null;
      void this.send(localTeamId);
    }, wait);
  }

  private retryLater(localTeamId: string): void {
    const r = this.run(localTeamId);
    const ms = this.retryMs[Math.min(r.retries, this.retryMs.length - 1)] ?? 60_000;
    r.retries++;
    if (r.timer !== null) this.timers.clear(r.timer);
    r.timer = this.timers.set(() => {
      r.timer = null;
      void this.schedule(localTeamId, 'retry');
    }, ms);
  }

  // --- Envío -----------------------------------------------------------------------

  private async send(localTeamId: string): Promise<void> {
    const r = this.run(localTeamId);
    if (r.running) {
      r.again = true;
      return;
    }
    r.running = true;
    r.again = false;
    try {
      await this.sendOnce(localTeamId);
    } finally {
      r.running = false;
      if (r.again) void this.schedule(localTeamId, 'change');
    }
  }

  private async block(localTeamId: string, message: string): Promise<void> {
    const link = await this.store.getLink(localTeamId);
    if (link) await this.store.updateLink({ ...link, autoBlocked: message });
    const r = this.run(localTeamId);
    r.firstPendingAt = null;
    this.setState(localTeamId, { status: 'attention', message });
  }

  private async sendOnce(localTeamId: string): Promise<void> {
    const r = this.run(localTeamId);
    const link = await this.store.getLink(localTeamId);
    if (!link || link.auto !== true || link.autoBlocked || link.readOnly || link.importState === 'pending') return;
    // Solo con permiso de entrenador vigente según la última comprobación de la sesión.
    const remote = this.remoteTeams().find((t) => t.teamId === link.remoteTeamId);
    if (!remote || remote.role !== 'coach' || remote.status !== 'active') {
      this.setState(localTeamId, { status: 'attention', message: 'Este dispositivo no tiene ahora permiso de entrenador en el equipo del club.' });
      return;
    }
    const device = await this.store.getDevice();
    if (!device) {
      this.setState(localTeamId, { status: 'attention', message: 'Este dispositivo no tiene sesión con el club.' });
      return;
    }
    let plan;
    try {
      plan = await this.clubSync.preview(localTeamId);
    } catch (e) {
      this.setState(localTeamId, { status: 'attention', message: e instanceof Error ? e.message : 'No se pudo preparar el envío.' });
      return;
    }
    if (plan.problems.length > 0) {
      await this.block(localTeamId, `Hay datos que el servidor no aceptaría: ${plan.problems[0]}`);
      return;
    }
    this.setState(localTeamId, { status: r.state.status === 'offline' ? 'offline' : 'sending' });
    try {
      const outcome = await runUpload(plan, {
        api: this.api,
        store: this.store,
        token: device.token,
        deviceId: device.deviceId,
        now: this.now,
        verify: false,
        // Sin esperas dentro del envío: los reintentos los gestiona este servicio.
        retryDelays: [],
      });
      if (outcome.status === 'stopped') {
        if (outcome.stop!.reason === 'offline') {
          this.setState(localTeamId, { status: 'offline', message: null });
          this.retryLater(localTeamId);
        } else if ((outcome.stop!.reason === 'conflict' || outcome.stop!.reason === 'recorded_elsewhere') && this.receiver && r.conflictRetries < 2) {
          // Conflicto o partido que ahora registra otro dispositivo: se recibe el
          // estado del club (lo afectado queda apartado, sin perder nada) y se reintenta.
          r.conflictRetries++;
          await this.receiver.pull(localTeamId);
          this.setState(localTeamId, { status: 'pending', message: null });
          r.again = true;
        } else {
          await this.block(localTeamId, `${outcome.stop!.record}: ${outcome.stop!.message}`);
        }
        return;
      }
      r.retries = 0;
      r.conflictRetries = 0;
      r.firstPendingAt = null;
      this.setState(localTeamId, { status: 'synced', message: null, lastSyncedAt: this.now().toISOString() });
    } catch (e) {
      if (e instanceof UploadBusyError) {
        // Hay un envío manual en curso: se vuelve a mirar después.
        this.setState(localTeamId, { status: 'pending' });
        this.retryLater(localTeamId);
        return;
      }
      if (e instanceof RemoteError) {
        await this.block(localTeamId, e.message);
        return;
      }
      throw e;
    }
  }
}
