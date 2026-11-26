// Repositorio que avisa de los cambios: delega todo en el repositorio local y,
// solo DESPUÉS de que una escritura quede guardada, notifica qué equipo ha
// cambiado. No altera cómo ni cuándo se guarda nada: el aviso es posterior y
// sus oyentes trabajan aparte (el registro no espera por ellos).
//
// También impide escribir en los equipos de solo lectura (copias de equipos del
// club que aún no se pueden editar en este dispositivo): la escritura se
// rechaza antes de guardar nada, venga de la pantalla que venga.
//
// Exclusión por equipo (exclusive): quien va a decidir sobre los datos de un
// equipo (p. ej. retirar o bloquear una copia que ha perdido el permiso) congela
// sus escrituras, espera a que terminen las ya empezadas y solo entonces mira los
// datos. Cada escritura se registra como «en curso» en el mismo instante en que
// comprueba si su equipo está congelado, sin ninguna espera entre ambas cosas: una
// escritura o entra en la decisión o se rechaza, nunca queda fuera.
import type { LocalSnapshot, Repository, SavedTogether } from '../data/repository';
import type { Id, Match, MatchEvent, Player, Team } from '../domain/types';
import { ValidationError } from '../domain/validation';

/** Escritura rechazada: el equipo es una copia del club de solo lectura en este dispositivo. */
export class ReadOnlyTeamError extends ValidationError {
  override name = 'ReadOnlyTeamError';
  constructor(message = 'Este equipo es una copia del club de solo lectura en este dispositivo: todavía no se puede modificar aquí. No se ha guardado nada.') {
    super(message);
  }
}

/** Escritura rechazada porque se está comprobando el permiso de este dispositivo en el equipo. */
export class TeamAccessCheckError extends ReadOnlyTeamError {
  override name = 'TeamAccessCheckError';
  constructor() {
    super('Se está comprobando el permiso de este dispositivo en el equipo: no se ha guardado nada. Si conservas el permiso, vuelve a intentarlo.');
  }
}

/** Exclusión de las escrituras de un equipo (la usa quien retira o bloquea copias). */
export interface TeamWriteGate {
  exclusive<T>(teamId: Id, fn: () => Promise<T>): Promise<T>;
}

/** ¿Es este equipo de solo lectura? Puede esperar a conocer los vínculos guardados. */
export type ReadOnlyCheck = {
  /** Hay algún equipo de solo lectura (si no, no se comprueba nada). */
  any(): boolean;
  isReadOnly(teamId: Id): Promise<boolean>;
};

export interface LocalChange {
  entity: 'team' | 'player' | 'match' | 'event';
  /** Equipo afectado (null si no se pudo saber, p. ej. una acción de un partido desconocido). */
  teamId: Id | null;
}

export type ChangeListener = (change: LocalChange) => void;

export class ObservableRepository implements Repository, TeamWriteGate {
  private readonly listeners = new Set<ChangeListener>();
  private readOnly: ReadOnlyCheck | null = null;
  /** Equipos congelados, con cuántas exclusiones activas tiene cada uno. */
  private readonly frozen = new Map<Id, number>();
  /** Escrituras en curso de cada equipo. */
  private readonly inflight = new Map<Id, Set<Promise<void>>>();

  constructor(private readonly inner: Repository) {}

  /** Activa la protección de los equipos de solo lectura. */
  protectReadOnly(check: ReadOnlyCheck): void {
    this.readOnly = check;
  }

  /** ¿Hace falta saber el equipo de cada escritura? Solo si hay copias que proteger o equipos congelados. */
  private watching(): boolean {
    return (this.readOnly?.any() ?? false) || this.frozen.size > 0;
  }

  private async guard(teamId: Id | undefined): Promise<void> {
    const check = this.readOnly;
    if (!check?.any() || teamId === undefined) return;
    if (await check.isReadOnly(teamId)) throw new ReadOnlyTeamError();
  }

  /**
   * Ejecuta una escritura de esos equipos. Comprobar si alguno está congelado y
   * registrarla como «en curso» son pasos síncronos y seguidos: ninguna exclusión
   * puede empezar entre ambos.
   */
  private tracked(teamIds: Iterable<Id | undefined>, write: () => Promise<void>): Promise<void> {
    const ids = [...new Set([...teamIds].filter((id): id is Id => id !== undefined))];
    if (ids.some((id) => this.frozen.has(id))) return Promise.reject(new TeamAccessCheckError());
    const p = write();
    for (const id of ids) {
      const running = this.inflight.get(id) ?? new Set<Promise<void>>();
      running.add(p);
      this.inflight.set(id, running);
    }
    const done = () => {
      for (const id of ids) {
        const running = this.inflight.get(id);
        running?.delete(p);
        if (running?.size === 0) this.inflight.delete(id);
      }
    };
    p.then(done, done);
    return p;
  }

  /**
   * Exclusión de las escrituras de un equipo mientras se ejecuta `fn`: las nuevas se
   * rechazan (TeamAccessCheckError) y las ya empezadas terminan antes de que `fn`
   * empiece. Admite exclusiones solapadas sobre el mismo equipo (dos retiradas a la vez).
   */
  async exclusive<T>(teamId: Id, fn: () => Promise<T>): Promise<T> {
    this.frozen.set(teamId, (this.frozen.get(teamId) ?? 0) + 1);
    try {
      for (let running = this.inflight.get(teamId); running && running.size > 0; running = this.inflight.get(teamId)) {
        await Promise.allSettled([...running]);
      }
      return await fn();
    } finally {
      const left = (this.frozen.get(teamId) ?? 1) - 1;
      if (left <= 0) this.frozen.delete(teamId);
      else this.frozen.set(teamId, left);
    }
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: LocalChange): void {
    for (const l of this.listeners) {
      try {
        l(change);
      } catch (e) {
        // Un oyente nunca puede afectar a una escritura ya guardada.
        console.error(e);
      }
    }
  }

  listTeams(): Promise<Team[]> {
    return this.inner.listTeams();
  }
  getTeam(id: Id): Promise<Team | undefined> {
    return this.inner.getTeam(id);
  }
  async saveTeam(team: Team): Promise<void> {
    await this.tracked([team.id], async () => {
      await this.guard(team.id);
      await this.inner.saveTeam(team);
    });
    this.emit({ entity: 'team', teamId: team.id });
  }

  listPlayers(teamId: Id): Promise<Player[]> {
    return this.inner.listPlayers(teamId);
  }
  getPlayer(id: Id): Promise<Player | undefined> {
    return this.inner.getPlayer(id);
  }
  async savePlayer(player: Player): Promise<void> {
    await this.tracked([player.teamId], async () => {
      await this.guard(player.teamId);
      await this.inner.savePlayer(player);
    });
    this.emit({ entity: 'player', teamId: player.teamId });
  }

  listMatches(teamId: Id): Promise<Match[]> {
    return this.inner.listMatches(teamId);
  }
  getMatch(id: Id): Promise<Match | undefined> {
    return this.inner.getMatch(id);
  }
  async saveMatch(match: Match): Promise<void> {
    // Por si el partido existía en otro equipo (no debería): tampoco se toca.
    const previous = this.watching() ? (await this.inner.getMatch(match.id))?.teamId : undefined;
    await this.tracked([match.teamId, previous], async () => {
      await this.guard(match.teamId);
      await this.guard(previous);
      await this.inner.saveMatch(match);
    });
    this.emit({ entity: 'match', teamId: match.teamId });
  }

  listEvents(matchId: Id): Promise<MatchEvent[]> {
    return this.inner.listEvents(matchId);
  }
  getEvent(id: Id): Promise<MatchEvent | undefined> {
    return this.inner.getEvent(id);
  }
  async saveEvent(event: MatchEvent): Promise<void> {
    // El equipo de una acción es el de su partido.
    const teamId = this.watching() ? (await this.inner.getMatch(event.matchId))?.teamId : undefined;
    await this.tracked([teamId], async () => {
      await this.guard(teamId);
      await this.inner.saveEvent(event);
    });
    if (this.listeners.size === 0) return;
    // Aviso con su equipo (lectura aparte, sin bloquear al que registra).
    void this.inner.getMatch(event.matchId).then(
      (m) => this.emit({ entity: 'event', teamId: m?.teamId ?? null }),
      () => this.emit({ entity: 'event', teamId: null }),
    );
  }

  async saveTogether(records: SavedTogether): Promise<void> {
    const teams = new Set<Id>([...(records.players ?? []).map((p) => p.teamId), ...(records.matches ?? []).map((m) => m.teamId)]);
    // Fichas que se borran: su equipo también debe poder modificarse.
    const deletedTeams = new Set<Id>();
    for (const id of records.deletePlayers ?? []) {
      const teamId = (await this.inner.getPlayer(id))?.teamId;
      if (teamId) {
        teams.add(teamId);
        deletedTeams.add(teamId);
      }
    }
    for (const e of records.events ?? []) {
      const teamId = (records.matches ?? []).find((m) => m.id === e.matchId)?.teamId ?? (await this.inner.getMatch(e.matchId))?.teamId;
      if (teamId) teams.add(teamId);
    }
    // Equipos donde estaban los partidos que se guardan (por si alguno cambiara de equipo).
    const previous: (Id | undefined)[] = [];
    if (this.watching()) for (const m of records.matches ?? []) previous.push((await this.inner.getMatch(m.id))?.teamId);
    await this.tracked([...teams, ...previous], async () => {
      for (const teamId of teams) await this.guard(teamId);
      for (const teamId of previous) await this.guard(teamId);
      await this.inner.saveTogether(records);
    });
    for (const teamId of teams) {
      if (records.players?.some((p) => p.teamId === teamId) || deletedTeams.has(teamId)) this.emit({ entity: 'player', teamId });
      if (records.matches?.some((m) => m.teamId === teamId)) this.emit({ entity: 'match', teamId });
      if (records.events?.length) this.emit({ entity: 'event', teamId });
    }
  }

  readAll(): Promise<LocalSnapshot> {
    return this.inner.readAll();
  }
}
