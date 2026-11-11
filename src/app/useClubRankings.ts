// Rankings del club en «Temporada»: qué grupos ofrece el servidor a este
// dispositivo. Sin grupos (o sin respuesta), la temporada queda como siempre.
// Todo vive en memoria mientras la pantalla está abierta: nada se guarda.
import { useCallback, useEffect, useState } from 'react';
import type { ClubRankingGroup } from '../remote/api';
import { isAccessLost } from '../remote/clubRankings';
import { RemoteError } from '../remote/api';
import { clubRankings, remote } from './remote';
import { useRemote } from './useRemote';

export type ClubGroupsState =
  | { status: 'loading' }
  /** El servidor no ofrece rankings del club a este dispositivo. `lost`: los ofrecía y ya no. */
  | { status: 'none'; lost: boolean }
  /** Sin conexión o sin respuesta: no se sabe, así que no se ofrecen. */
  | { status: 'unknown' }
  | { status: 'ready'; groups: ClubRankingGroup[] };

/**
 * Grupos de los rankings del club `clubId` que el servidor deja ver a este
 * dispositivo. Se piden al abrir la sección, al recuperar la conexión si no se
 * pudo, al cambiar los permisos de la sesión en ese club y con `recheck`.
 */
export function useClubRankingGroups(clubId: string | null | undefined): { state: ClubGroupsState; recheck: () => void } {
  const session = useRemote(remote);
  // Cambia cuando cambian los permisos de este dispositivo en el club.
  const access = session.teams
    .filter((t) => t.clubId === clubId)
    .map((t) => `${t.teamId}:${t.role}:${t.status}`)
    .sort()
    .join(',');
  const [attempt, setAttempt] = useState(0);
  const recheck = useCallback(() => setAttempt((n) => n + 1), []);
  // Cada respuesta va con la petición a la que contesta: nunca se muestra la de otra.
  const request = `${clubId ?? ''}|${access}|${attempt}`;
  const [result, setResult] = useState<{ request: string; groups: ClubRankingGroup[] | null } | null>(null);
  // Si alguna vez los ofreció en esta pantalla (para avisar si se retiran).
  const [offered, setOffered] = useState(false);
  const enabled = Boolean(clubRankings && clubId && access);

  useEffect(() => {
    if (!clubRankings || !clubId || !access) return;
    let alive = true;
    void clubRankings.groups(clubId).then(
      (groups) => {
        if (!alive) return;
        setResult({ request, groups });
        if (groups.length) setOffered(true);
      },
      (e: unknown) => {
        if (!alive) return;
        // Permiso retirado o sesión no válida: ninguno. Sin conexión: se desconoce (y no se muestra nada antiguo).
        const none = isAccessLost(e) || (e instanceof RemoteError && e.kind === 'unauthorized');
        setResult({ request, groups: none ? [] : null });
      },
    );
    return () => {
      alive = false;
    };
  }, [clubId, access, request]);

  const state: ClubGroupsState = !enabled
    ? { status: 'none', lost: offered }
    : result?.request !== request
      ? { status: 'loading' }
      : result.groups === null
        ? { status: 'unknown' }
        : result.groups.length
          ? { status: 'ready', groups: result.groups }
          : { status: 'none', lost: offered };

  // Sin respuesta al abrir: se vuelve a preguntar al recuperar la conexión (una vez, sin sondeos).
  useEffect(() => {
    if (state.status !== 'unknown') return;
    window.addEventListener('online', recheck);
    return () => window.removeEventListener('online', recheck);
  }, [state.status, recheck]);

  return { state, recheck };
}
