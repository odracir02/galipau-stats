// Compatibilidad con versiones de la PWA que no conocen el cuerpo técnico
// (oficiales, role: 'official'). Una versión antigua trataría a un oficial como
// un jugador de campo con dorsal 0: lo mostraría en estadísticas, podría
// atribuirle goles, cambiarle el rol al editarlo o quitarlo de una convocatoria.
//
// La PWA nueva declara en cada petición `X-GalipauStats-Features: officials`. Si
// una petición no lo declara y el equipo tiene algún oficial (también eliminado),
// las lecturas y escrituras de ese equipo responden 503 `update_required`. La
// versión publicada lo trata como un fallo temporal del servidor: conserva sus
// datos y pendientes, reintenta con esperas crecientes y no toca la sesión ni los
// permisos (un 401, 403 o 404 sí tendrían consecuencias en ella).
//
// La cabecera no autoriza nada: los permisos se comprueban siempre igual. Los
// equipos sin oficiales funcionan exactamente como antes con cualquier versión.
import type { Id } from '../../src/domain/types';
import { authorize } from './auth';
import type { Db } from './db';
import { HttpError } from './errors';
import type { AuthContext } from './model';

export const FEATURES_HEADER = 'X-GalipauStats-Features';

export interface ClientFeatures {
  /** Conoce el cuerpo técnico (role: 'official'). */
  officials: boolean;
}

export const NO_FEATURES: ClientFeatures = { officials: false };

export function clientFeatures(request: Request): ClientFeatures {
  const declared = (request.headers.get(FEATURES_HEADER) ?? '').split(',').map((f) => f.trim().toLowerCase());
  return { officials: declared.includes('officials') };
}

export const updateRequired = () =>
  new HttpError(503, 'update_required', 'Actualiza la aplicación para seguir sincronizando este equipo.');

/**
 * Lecturas y escrituras de los datos de un equipo: una versión que no conoce
 * los oficiales no puede usarlas si el equipo tiene alguno. Antes se comprueba
 * el acceso al equipo, para no revelar nada a quien no lo tiene.
 */
export async function assertCompatible(db: Db, auth: AuthContext, teamId: Id, features: ClientFeatures): Promise<void> {
  if (features.officials) return;
  await authorize(db, auth, teamId, 'team.read');
  const official = await db.prepare("SELECT 1 AS ok FROM players WHERE team_id = ? AND role = 'official' LIMIT 1").bind(teamId).first();
  if (official) throw updateRequired();
}
