import { useEffect, useState } from 'react';
import type { TeamLink } from '../remote/store';
import { clubSync, teamImporter, teamPuller } from './remote';

/**
 * Cambia cada vez que llegan cambios del club a este equipo local (o, con
 * `matchId`, solo a ese partido): las pantallas lo usan para volver a leer.
 */
export function useRemoteRevision(teamId: string | undefined, matchId?: string): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!teamPuller || (!teamId && !matchId)) return;
    return teamPuller.onRemoteChange((id, matchIds) => {
      if ((teamId === undefined || id === teamId) && (matchId === undefined || matchIds.has(matchId))) setRevision((r) => r + 1);
    });
  }, [teamId, matchId]);
  return revision;
}

/** Vínculo del equipo local con el club (null si no tiene; undefined mientras se lee). */
export function useTeamLink(teamId: string | undefined): TeamLink | null | undefined {
  const [link, setLink] = useState<TeamLink | null | undefined>(undefined);
  const revision = useRemoteRevision(teamId);
  const [version, setVersion] = useState(0);
  useEffect(() => teamImporter?.subscribe(() => setVersion((v) => v + 1)), []);
  useEffect(() => {
    if (!clubSync || !teamId) return;
    let alive = true;
    void clubSync.getLink(teamId).then((l) => alive && setLink(l));
    return () => {
      alive = false;
    };
  }, [teamId, revision, version]);
  return clubSync && teamId ? link : null;
}
