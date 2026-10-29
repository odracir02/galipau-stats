import { useCallback, useSyncExternalStore } from 'react';
import type { ClubViewer, TeamView } from '../remote/viewer';

const NONE: TeamView = { cached: null, loading: false, problem: null };
const noop = () => () => undefined;

/** Datos descargados de un equipo del club (o vacío si la versión no usa servidor). */
export function useTeamView(viewer: ClubViewer | null, teamId: string): TeamView {
  const get = useCallback(() => (viewer ? viewer.view(teamId) : NONE), [viewer, teamId]);
  return useSyncExternalStore(viewer?.subscribe ?? noop, get);
}
