// Rankings del club en la aplicación: solo lectura y solo con conexión. El
// servidor decide qué grupos puede ver el dispositivo y calcula las
// clasificaciones (aquí no se calcula nada). Nada se guarda en el dispositivo:
// ni en localStorage, ni en IndexedDB, ni en la caché del service worker.
import { RemoteError, type Api, type ClubRankingGroup, type ClubRankings } from './api';
import type { AccountStore } from './store';

const GENDER_LABEL: Record<ClubRankingGroup['gender'], string> = { male: 'Masculino', female: 'Femenino', mixed: 'Mixto' };

/** «senior · Masculino · 2026/27». */
export const groupLabel = (g: ClubRankingGroup) => `${g.group} · ${GENDER_LABEL[g.gender]} · ${g.season}`;
export const groupKey = (g: ClubRankingGroup) => `${g.season}|${g.gender}|${g.group}`;

/** Grupos sin repetir, en el orden del servidor. */
export function uniqueGroups(groups: readonly ClubRankingGroup[]): ClubRankingGroup[] {
  const seen = new Set<string>();
  return groups.filter((g) => !seen.has(groupKey(g)) && seen.add(groupKey(g)));
}

/**
 * Grupo con el que se abre «Mi club»: el único que, según el servidor, incluye
 * el equipo abierto; si no hay ninguno, hay varios o el servidor no lo indica,
 * el primero (nunca se deduce por nombres, categorías ni códigos).
 */
export function initialGroup(groups: readonly ClubRankingGroup[], teamId: string | null | undefined): ClubRankingGroup | undefined {
  const matches = teamId ? groups.filter((g) => Array.isArray(g.teamIds) && g.teamIds.includes(teamId)) : [];
  return matches.length === 1 ? matches[0] : groups[0];
}

/** El servidor confirma que ya no hay acceso (permiso retirado, club o grupo no disponibles). */
export const isAccessLost = (e: unknown) => e instanceof RemoteError && (e.kind === 'forbidden' || e.kind === 'not_found');

export class ClubRankingsClient {
  constructor(
    private readonly api: Api,
    private readonly store: AccountStore,
    /** Se avisa cuando el servidor rechaza la credencial (para comprobar la sesión). */
    private readonly onUnauthorized: () => void = () => undefined,
  ) {}

  private async token(): Promise<string> {
    const device = await this.store.getDevice();
    if (!device) throw new RemoteError('unauthorized', 'La sesión de este dispositivo ya no es válida.');
    return device.token;
  }

  private async guard<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.token());
    } catch (e) {
      if (e instanceof RemoteError && e.kind === 'unauthorized') this.onUnauthorized();
      throw e;
    }
  }

  /** Grupos que el dispositivo puede consultar en el club (vacío si ninguno). */
  async groups(clubId: string): Promise<ClubRankingGroup[]> {
    return uniqueGroups((await this.guard((t) => this.api.clubRankingGroups(t, clubId))).groups);
  }

  rankings(clubId: string, group: ClubRankingGroup, playerIds: readonly string[] = []): Promise<ClubRankings> {
    return this.guard((t) => this.api.clubRankings(t, clubId, group, playerIds));
  }
}
