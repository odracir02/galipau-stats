import { useEffect, useEffectEvent } from 'react';
import { clubViewer, remote } from './remote';
import { useRemote } from './useRemote';
import { useTeamView } from './useTeamView';

/**
 * Datos de un equipo del club: muestra lo descargado (también sin conexión) y,
 * al abrir el equipo, lo descarga de nuevo si la sesión da acceso. Después solo
 * se actualiza con «Actualizar».
 */
export function useRemoteTeamData(teamId: string) {
  const session = useRemote(remote);
  const view = useTeamView(clubViewer, teamId);
  const team = session.teams.find((t) => t.teamId === teamId);
  const canRefresh = Boolean(team && team.status === 'active');
  const download = useEffectEvent(() => {
    if (clubViewer && team) void clubViewer.refresh(team);
  });

  useEffect(() => {
    if (clubViewer) void clubViewer.load(teamId);
  }, [teamId]);
  useEffect(() => {
    if (canRefresh) download();
  }, [teamId, canRefresh]);
  return { session, view, team };
}
