// Copia de seguridad local: todos los datos del dispositivo en un archivo JSON.
// Solo lectura: no modifica IndexedDB ni llama a ningún servidor. Conserva los
// identificadores y las relaciones tal cual, para poder importarla en el futuro.
import { todayLocal } from '../domain/format';
import type { LocalSnapshot } from './repository';

export const BACKUP_FORMAT = 'galipaustats-backup';
/** Versión del formato del archivo (no de la app). Sube si cambia su estructura. */
export const BACKUP_VERSION = 1;

export interface Backup extends LocalSnapshot {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  /** Momento de la exportación (ISO 8601, UTC). */
  exportedAt: string;
  /** Versión del almacenamiento local de la que procede (IndexedDB). */
  storageVersion: number;
  counts: { teams: number; players: number; matches: number; events: number };
}

/**
 * Construye la copia. Ordena los registros de forma estable (por id) para que
 * dos exportaciones de los mismos datos sean idénticas salvo la fecha.
 */
export function buildBackup(snapshot: LocalSnapshot, now = new Date(), storageVersion = 1): Backup {
  const byId = <T extends { id: string }>(list: readonly T[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
  const teams = byId(snapshot.teams);
  const players = byId(snapshot.players);
  const matches = byId(snapshot.matches);
  const events = byId(snapshot.events);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    storageVersion,
    counts: { teams: teams.length, players: players.length, matches: matches.length, events: events.length },
    teams,
    players,
    matches,
    events,
  };
}

export function serializeBackup(backup: Backup): string {
  return JSON.stringify(backup, null, 2);
}

/** Nombre del archivo con la fecha local, p. ej. galipaustats-backup-2026-10-28.json. */
export function backupFileName(now = new Date()): string {
  return `galipaustats-backup-${todayLocal(now)}.json`;
}

/**
 * Comprueba la integridad de una copia: formato, recuentos, identificadores
 * únicos y que toda relación apunte a un registro incluido. Devuelve la lista
 * de problemas (vacía si es correcta). Sirve antes de guardar y servirá para
 * importar.
 */
export function validateBackup(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) return ['No es un objeto.'];
  const b = value as Partial<Backup>;
  if (b.format !== BACKUP_FORMAT) problems.push('Formato desconocido.');
  if (b.version !== BACKUP_VERSION) problems.push(`Versión de formato no admitida: ${String(b.version)}.`);
  if (typeof b.exportedAt !== 'string' || Number.isNaN(Date.parse(b.exportedAt))) problems.push('Fecha de exportación no válida.');
  const lists = ['teams', 'players', 'matches', 'events'] as const;
  for (const key of lists) if (!Array.isArray(b[key])) problems.push(`Falta la lista «${key}».`);
  if (problems.length) return problems;

  const backup = b as Backup;
  for (const key of lists) {
    if (backup.counts?.[key] !== backup[key].length) problems.push(`El recuento de «${key}» no coincide.`);
    const ids = new Set<string>();
    for (const item of backup[key] as { id?: unknown }[]) {
      if (typeof item.id !== 'string' || !item.id) problems.push(`Registro sin identificador en «${key}».`);
      else if (ids.has(item.id)) problems.push(`Identificador repetido en «${key}»: ${item.id}.`);
      else ids.add(item.id);
    }
  }
  const teams = new Set(backup.teams.map((t) => t.id));
  const players = new Set(backup.players.map((p) => p.id));
  const matches = new Set(backup.matches.map((m) => m.id));
  for (const p of backup.players) if (!teams.has(p.teamId)) problems.push(`Jugador ${p.id} de un equipo que no está en la copia.`);
  for (const m of backup.matches) {
    if (!teams.has(m.teamId)) problems.push(`Partido ${m.id} de un equipo que no está en la copia.`);
    for (const s of m.squad) if (!players.has(s.playerId)) problems.push(`Convocado ${s.playerId} del partido ${m.id} sin jugador en la copia.`);
  }
  for (const e of backup.events) {
    if (!matches.has(e.matchId)) problems.push(`Acción ${e.id} de un partido que no está en la copia.`);
    if (e.playerId !== null && !players.has(e.playerId)) problems.push(`Acción ${e.id} de un jugador que no está en la copia.`);
  }
  return problems;
}
