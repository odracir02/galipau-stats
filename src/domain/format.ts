import type { LocalDate, Team } from './types';

/** Nombre con el que el equipo aparece en marcadores y resultados. */
export function publicTeamName(team: Pick<Team, 'name' | 'publicName'>): string {
  return team.publicName?.trim() || team.name;
}

/** Rival con la misma presentación en todos los partidos, sea local o visitante. */
export function opponentLabel(opponent: string): string {
  return `vs ${opponent}`;
}

/** Formatea milisegundos de partido como mm:ss (los minutos pueden pasar de 60). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Interpreta "mm:ss" o "mm" y devuelve milisegundos, o null si no es válido.
 * Acepta también "." o "," como separador (teclados numéricos de móvil).
 */
export function parseClock(text: string): number | null {
  const match = /^\s*(\d{1,3})(?:[:.,](\d{1,2}))?\s*$/.exec(text);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = match[2] === undefined ? 0 : Number(match[2]);
  if (seconds > 59) return null;
  return (minutes * 60 + seconds) * 1000;
}

/** Porcentaje con un decimal, o «—» si no hay datos. */
export function formatPct(value: number | null): string {
  if (value === null) return '—';
  return `${value.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
}

export function todayLocal(now: Date = new Date()): LocalDate {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatDate(date: LocalDate): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

/** Temporada deportiva propuesta para una fecha (de julio a junio). */
export function seasonFor(now: Date = new Date()): string {
  const y = now.getFullYear();
  const start = now.getMonth() >= 6 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}
