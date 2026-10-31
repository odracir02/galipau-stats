// Vinculación de equipos locales con equipos del club y envío manual de sus
// datos. Nada de esto se ejecuta solo: vincular y enviar son siempre acciones
// explícitas del usuario. Los datos locales solo se leen.
import type { Repository } from '../data/repository';
import { RemoteError, type Api, type RemoteTeam } from './api';
import { buildPlan, type UploadPlan } from './plan';
import type { AccountStore, TeamLink, UploadRecord } from './store';
import { pendingChanges, runUpload, verifyUpload, type PendingChanges, type UploadDeps, type UploadOutcome, type UploadProgress } from './upload';

/** Recepción de cambios del club (pull.ts): antes de comprobar un envío, se incorpora lo de los demás. */
export interface Receiver {
  pull(localTeamId: string): Promise<unknown>;
}

export class ClubSync {
  private receiver: Receiver | null = null;

  /** Con recepción de cambios: un envío manual recibe lo del club antes de comprobar. */
  receiveWith(receiver: Receiver): this {
    this.receiver = receiver;
    return this;
  }

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
    // Copia del club de solo lectura: desde aquí no se envía nada (aún no hay sincronización en los dos sentidos).
    if (link.readOnly || link.importState === 'pending') {
      throw new RemoteError('forbidden', 'Esta copia del club es de solo lectura en este dispositivo: todavía no se puede enviar nada desde aquí.');
    }
    const team = await this.repo.getTeam(localTeamId);
    if (!team) throw new RemoteError('not_found', 'El equipo local no existe.');
    const sentMatches = new Set((await this.store.listMeta(link.remoteTeamId)).filter((m) => m.entity === 'match').map((m) => m.entityId));
    const plan = buildPlan(await this.repo.readAll(), team, link, sentMatches);
    // Los registros en conflicto con el club se apartan (y las acciones de un
    // partido en conflicto): esperan a que el usuario elija; lo demás se envía.
    const conflicted = new Set((link.conflicts ?? []).map((c) => c.key));
    if (conflicted.size === 0) return plan;
    const matchOut = (id: string) => conflicted.has(`match:${id}`);
    const setAside = [...conflicted];
    const events = plan.events.filter((e) => !conflicted.has(`event:${e.id}`) && !matchOut(e.matchId));
    for (const e of plan.events) if (!events.includes(e)) setAside.push(`event:${e.id}`);
    return {
      ...plan,
      players: plan.players.filter((p) => !conflicted.has(`player:${p.id}`)),
      matches: plan.matches.filter((m) => !matchOut(m.id)),
      events,
      setAside: [...new Set(setAside)],
    };
  }

  /** ¿Está este partido en el servidor del club (enviado y confirmado alguna vez)? */
  async isMatchSynced(matchId: string): Promise<boolean> {
    return (await this.store.getMeta('match', matchId)) !== null;
  }

  /** Lo que se enviaría ahora, sin enviar nada. */
  async pending(localTeamId: string): Promise<PendingChanges> {
    return pendingChanges(await this.preview(localTeamId), this.store);
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
      const deps = { api: this.api, store: this.store, token: device.token, deviceId: device.deviceId, onProgress, now: this.now, ...this.retry };
      if (this.receiver) {
        // En los dos sentidos: enviar, recibir lo de los demás y comprobar que todo coincide.
        outcome = await runUpload(plan, { ...deps, verify: false });
        if (outcome.status === 'sent') {
          await this.receiver.pull(localTeamId);
          outcome = { ...outcome, ...(await verifyUpload(await this.preview(localTeamId), deps)) };
        }
      } else {
        outcome = await runUpload(plan, deps);
      }
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
    // Un envío manual completo y comprobado vuelve a activar el envío automático detenido
    // (se relee el vínculo: la recepción puede haberlo actualizado).
    const fresh = await this.store.getLink(localTeamId);
    if (outcome.status === 'verified' && fresh?.autoBlocked) {
      await this.store.updateLink({ ...fresh, autoBlocked: null });
    }
    return outcome;
  }
}
