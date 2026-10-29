import { useSyncExternalStore } from 'react';
import type { RemoteSession, RemoteState } from '../remote/session';

const NONE: RemoteState = {
  ready: true,
  linked: false,
  revoked: false,
  teams: [],
  checkedAt: null,
  checking: false,
  problem: null,
};
const noop = () => () => undefined;

/** Estado de la sesión con el servidor (o vacío si la versión no usa servidor). */
export function useRemote(session: RemoteSession | null): RemoteState {
  return useSyncExternalStore(session?.subscribe ?? noop, session?.getState ?? (() => NONE));
}
