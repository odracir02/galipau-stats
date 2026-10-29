import { useCallback, useSyncExternalStore } from 'react';
import type { AutoState, AutoSync } from '../remote/autosync';

const OFF: AutoState = { status: 'off', message: null, lastSyncedAt: null };
const noop = () => () => undefined;

/** Estado del envío automático de un equipo local (o «desactivado» si no hay servidor). */
export function useAutoSync(auto: AutoSync | null, localTeamId: string): AutoState {
  const get = useCallback(() => (auto ? auto.state(localTeamId) : OFF), [auto, localTeamId]);
  return useSyncExternalStore(auto?.subscribe ?? noop, get);
}
