// Repositorio que avisa de los cambios: delega todo en el repositorio local y,
// solo DESPUÉS de que una escritura quede guardada, notifica qué equipo ha
// cambiado. No altera cómo ni cuándo se guarda nada: el aviso es posterior y
// sus oyentes trabajan aparte (el registro no espera por ellos).
import type { LocalSnapshot, Repository } from '../data/repository';
import type { Id, Match, MatchEvent, Player, Team } from '../domain/types';

export interface LocalChange {
  entity: 'team' | 'player' | 'match' | 'event';
  /** Equipo afectado (null si no se pudo saber, p. ej. una acción de un partido desconocido). */
  teamId: Id | null;
}

export type ChangeListener = (change: LocalChange) => void;

export class ObservableRepository implements Repository {
  private readonly listeners = new Set<ChangeListener>();

  constructor(private readonly inner: Repository) {}

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
    await this.inner.saveTeam(team);
    this.emit({ entity: 'team', teamId: team.id });
  }

  listPlayers(teamId: Id): Promise<Player[]> {
    return this.inner.listPlayers(teamId);
  }
  getPlayer(id: Id): Promise<Player | undefined> {
    return this.inner.getPlayer(id);
  }
  async savePlayer(player: Player): Promise<void> {
    await this.inner.savePlayer(player);
    this.emit({ entity: 'player', teamId: player.teamId });
  }

  listMatches(teamId: Id): Promise<Match[]> {
    return this.inner.listMatches(teamId);
  }
  getMatch(id: Id): Promise<Match | undefined> {
    return this.inner.getMatch(id);
  }
  async saveMatch(match: Match): Promise<void> {
    await this.inner.saveMatch(match);
    this.emit({ entity: 'match', teamId: match.teamId });
  }

  listEvents(matchId: Id): Promise<MatchEvent[]> {
    return this.inner.listEvents(matchId);
  }
  getEvent(id: Id): Promise<MatchEvent | undefined> {
    return this.inner.getEvent(id);
  }
  async saveEvent(event: MatchEvent): Promise<void> {
    await this.inner.saveEvent(event);
    if (this.listeners.size === 0) return;
    // El equipo de una acción es el de su partido (lectura aparte, sin bloquear al que registra).
    void this.inner.getMatch(event.matchId).then(
      (m) => this.emit({ entity: 'event', teamId: m?.teamId ?? null }),
      () => this.emit({ entity: 'event', teamId: null }),
    );
  }

  readAll(): Promise<LocalSnapshot> {
    return this.inner.readAll();
  }
}
