import { useSyncExternalStore } from 'react';
import type { TeamLink } from '../remote/store';
import { teamImporter } from './remote';

const noop = () => () => undefined;

/** Vínculo de la copia del club si este equipo local lo es (null si es un equipo propio). */
export function useImportedTeam(teamId: string): TeamLink | null {
  return useSyncExternalStore(teamImporter?.subscribe ?? noop, () => teamImporter?.importedLink(teamId) ?? null);
}

/** ¿Es este equipo una copia del club de solo lectura en este dispositivo? */
export function useReadOnlyTeam(teamId: string): boolean {
  const link = useImportedTeam(teamId);
  return link !== null && (link.readOnly === true || link.importState === 'pending');
}
