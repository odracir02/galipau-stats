import { useEffect } from 'react';
import { clubViewer, liveFeed, remote } from './remote';
import { useRemote } from './useRemote';
import { useTeamView } from './useTeamView';

/**
 * Datos de un equipo del club: muestra lo descargado (también sin conexión) y,
 * mientras la pantalla está abierta y la sesión da acceso, lo mantiene al día en
 * directo (ver live.ts). «Actualizar» sigue descargándolo entero.
 */
export function useRemoteTeamData(teamId: string) {
  const session = useRemote(remote);
  const view = useTeamView(clubViewer, teamId);
  const team = session.teams.find((t) => t.teamId === teamId);
  const canRefresh = Boolean(team && team.status === 'active');

  useEffect(() => {
    if (clubViewer) void clubViewer.load(teamId);
  }, [teamId]);
  useEffect(() => (canRefresh && liveFeed ? liveFeed.watch(teamId) : undefined), [teamId, canRefresh]);
  return { session, view, team };
}
