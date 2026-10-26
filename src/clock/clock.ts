// Cronómetro orientativo del partido. Funciones puras: reciben el estado y el
// instante actual (Date.now()) y devuelven un estado nuevo, sin mutar.
//
// El tiempo transcurrido se reconstruye como baseMs + (ahora − anclaje), de modo
// que sobrevive a bloqueos, cambios de app, recargas y reaperturas de la PWA.
import type { ClockState, Period } from '../domain/types';

export const MINUTE_MS = 60_000;
/** Ventana final de cada parte en la que mostramos la cuenta atrás. */
export const COUNTDOWN_WINDOW_MS = 5 * MINUTE_MS;

export function initialClock(): ClockState {
  return { period: 1, running: false, baseMs: 0, anchorWallMs: null };
}

/** Tiempo de partido (ms) en el instante `now`. */
export function elapsedMs(clock: ClockState, now: number): number {
  if (!clock.running || clock.anchorWallMs === null) return clock.baseMs;
  // Si el reloj del dispositivo retrocede, no restamos tiempo: congelamos en baseMs.
  return clock.baseMs + Math.max(0, now - clock.anchorWallMs);
}

export function start(clock: ClockState, now: number): ClockState {
  if (clock.running) return clock;
  return { ...clock, running: true, anchorWallMs: now };
}

export function pause(clock: ClockState, now: number): ClockState {
  if (!clock.running) return clock;
  return { ...clock, running: false, baseMs: elapsedMs(clock, now), anchorWallMs: null };
}

export function toggle(clock: ClockState, now: number): ClockState {
  return clock.running ? pause(clock, now) : start(clock, now);
}

/** Ajuste manual: fija el tiempo de partido sin cambiar si está en marcha o parado. */
export function setTime(clock: ClockState, timeMs: number, now: number): ClockState {
  const baseMs = Math.max(0, Math.round(timeMs));
  return { ...clock, baseMs, anchorWallMs: clock.running ? now : null };
}

/** Desplaza el tiempo actual (p. ej. ±10 s). */
export function shift(clock: ClockState, deltaMs: number, now: number): ClockState {
  return setTime(clock, elapsedMs(clock, now) + deltaMs, now);
}

/** Inicio nominal de una parte (0:00 o 30:00 con partes de 30 min). */
export function periodStartMs(period: Period, halfMinutes: number): number {
  return (period - 1) * halfMinutes * MINUTE_MS;
}

/** Final nominal de una parte (30:00 o 60:00 con partes de 30 min). */
export function periodEndMs(period: Period, halfMinutes: number): number {
  return period * halfMinutes * MINUTE_MS;
}

/** Segunda parte: arranca parada en el inicio nominal, a la espera del pitido. */
export function startSecondHalf(halfMinutes: number): ClockState {
  return { period: 2, running: false, baseMs: periodStartMs(2, halfMinutes), anchorWallMs: null };
}

/**
 * Cuenta atrás orientativa hasta el final nominal de la parte. Solo existe en los
 * últimos cinco minutos (desde el 25 y el 55); nunca es negativa. El cronómetro
 * principal sigue contando hacia delante aunque se supere el final nominal.
 */
export function countdownMs(clock: ClockState, now: number, halfMinutes: number): number | null {
  const end = periodEndMs(clock.period, halfMinutes);
  const t = elapsedMs(clock, now);
  if (t < end - COUNTDOWN_WINDOW_MS) return null;
  return Math.max(0, end - t);
}
