// Vinculación de equipos locales con equipos del club y envío manual de sus
// datos. Nada de esto se ejecuta solo: vincular y enviar son siempre acciones
// explícitas del usuario. Los datos locales solo se leen.
import type { Repository } from '../data/repository';
import { RemoteError, type Api, type RemoteTeam } from './api';
import { buildPlan, type UploadPlan } from './plan';
import type { AccountStore, TeamLink, UploadRecord } from './store';
import { runUpload, type UploadDeps, type UploadOutcome, type UploadProgress } from './upload';

export class ClubSync {
  constructor(
    private readonly repo: Repository,
    private readonly store: AccountStore,
    private readonly api: Api,
    /** Equipos y permisos vigentes según la última comprobación de la sesión. */
    private readonly remoteTeams: () => RemoteTeam[],
    private readonly now: () => Date = () => new Date(),
    /** Reintentos ante fallos de red (las pruebas los acortan). */
    private readonly retry: Pick<UploadDeps, 'retryDelays' | 'sleep'> = {},
  ) {}

  /** Equipos del club en los que este dispositivo puede escribir (entrenador, club activo). */
  writableTeams(): RemoteTeam[] {
    return this.remoteTeams().filter((t) => t.role === 'coach' && t.status === 'active');
  }

  getLink(localTeamId: string): Promise<TeamLink | null> {
    return this.store.getLink(localTeamId);
  }

  /** Equipos del club que se pueden vincular a este equipo local (con permiso y libres). */
  async linkCandidates(): Promise<RemoteTeam[]> {
    const taken = new Set((await this.store.listLinks()).map((l) => l.remoteTeamId));
    return this.writableTeams().filter((t) => !taken.has(t.teamId));
  }

  /**
   * Vincula un equipo local con uno del club. Solo con permiso de entrenador y
   * si ninguno de los dos está ya vinculado. No cambia nada en la base local.
   */
  async link(localTeamId: string, remoteTeamId: string): Promise<TeamLink> {
    const team = await this.repo.getTeam(localTeamId);
    if (!team) throw new RemoteError('not_found', 'El equipo local no existe.');
    const remote = this.writableTeams().find((t) => t.teamId === remoteTeamId);
    if (!remote) throw new RemoteError('forbidden', 'Solo se puede vincular un equipo del club en el que tengas permiso de entrenador.');
    const link: TeamLink = {
      localTeamId,
      remoteTeamId,
      remoteTeamName: remote.name,
      remoteTeamCode: remote.code,
      remoteSeason: remote.season,
      clubName: remote.clubName,
      linkedAt: this.now().toISOString(),
    };
    await this.store.addLink(link);
    return link;
  }

  /** ¿Se ha enviado ya algo con este vínculo? Entonces ya no se puede deshacer desde aquí. */
  async hasSent(link: TeamLink): Promise<boolean> {
    return (await this.store.listMeta(link.remoteTeamId)).length > 0;
  }

  /** Deshace un vínculo solo si todavía no se ha enviado nada con él. */
  async unlink(localTeamId: string): Promise<void> {
    const link = await this.store.getLink(localTeamId);
    if (!link) return;
    if (await this.hasSent(link)) throw new RemoteError('conflict', 'Ya se han enviado datos con este vínculo: no se puede deshacer desde el dispositivo.');
    await this.store.removeLink(localTeamId);
  }

  /** Previsualización del envío: lee la base local completa sin modificarla. */
  async preview(localTeamId: string): Promise<UploadPlan> {
    const link = await this.store.getLink(localTeamId);
    if (!link) throw new RemoteError('not_found', 'El equipo no está vinculado con ningún equipo del club.');
    const team = await this.repo.getTeam(localTeamId);
    if (!team) throw new RemoteError('not_found', 'El equipo local no existe.');
    return buildPlan(await this.repo.readAll(), team, link);
  }

  lastUpload(localTeamId: string): Promise<UploadRecord | null> {
    return this.store.lastUpload(localTeamId);
  }

  /**
   * Envía el equipo vinculado y comprueba el resultado con el servidor. Exige
   * sesión, permiso de entrenador vigente y un plan sin problemas. Anota el
   * resultado en el historial (sin datos sensibles).
   */
  async upload(localTeamId: string, onProgress?: (p: UploadProgress) => void): Promise<UploadOutcome> {
    const plan = await this.preview(localTeamId);
    if (plan.problems.length > 0) throw new RemoteError('invalid', 'Hay datos que el servidor no aceptaría. Revisa la lista antes de enviar.');
    if (!this.writableTeams().some((t) => t.teamId === plan.link.remoteTeamId)) {
      throw new RemoteError('forbidden', 'Este dispositivo no tiene permiso de entrenador en el equipo del club.');
    }
    const device = await this.store.getDevice();
    if (!device) throw new RemoteError('unauthorized', 'Este dispositivo no tiene sesión.');
    const record: UploadRecord = {
      id: `${plan.link.remoteTeamId}:${this.now().toISOString()}`,
      localTeamId,
      remoteTeamId: plan.link.remoteTeamId,
      startedAt: this.now().toISOString(),
      finishedAt: null,
      status: 'running',
      sent: { players: 0, matches: 0, events: 0 },
      skipped: 0,
      message: null,
    };
    await this.store.saveUpload(record);
    let outcome: UploadOutcome;
    try {
      outcome = await runUpload(plan, {
        api: this.api,
        store: this.store,
        token: device.token,
        deviceId: device.deviceId,
        onProgress,
        now: this.now,
        ...this.retry,
      });
    } catch (e) {
      await this.store.saveUpload({ ...record, finishedAt: this.now().toISOString(), status: 'interrupted', message: e instanceof Error ? e.message : 'Error' });
      throw e;
    }
    await this.store.saveUpload({
      ...record,
      finishedAt: this.now().toISOString(),
      status: outcome.status === 'stopped' ? (outcome.stop?.reason === 'offline' ? 'interrupted' : 'stopped') : outcome.status,
      sent: outcome.sent,
      skipped: outcome.unchanged,
      message: outcome.stop?.message ?? (outcome.differences.length ? `${outcome.differences.length} diferencias` : null),
    });
    return outcome;
  }
}
