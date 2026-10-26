import { describe, expect, it } from 'vitest';
import {
  countdownMs,
  elapsedMs,
  initialClock,
  MINUTE_MS,
  pause,
  setTime,
  shift,
  start,
  startSecondHalf,
  toggle,
} from './clock';

const T0 = 1_700_000_000_000;
const s = (n: number) => n * 1000;

describe('cronómetro', () => {
  it('empieza parado en 00:00', () => {
    const c = initialClock();
    expect(c.running).toBe(false);
    expect(elapsedMs(c, T0 + s(100))).toBe(0);
  });

  it('cuenta a partir de la referencia temporal, no de intervalos', () => {
    const c = start(initialClock(), T0);
    expect(elapsedMs(c, T0 + s(90))).toBe(s(90));
  });

  it('pausado no avanza y al reanudar continúa desde donde estaba', () => {
    let c = start(initialClock(), T0);
    c = pause(c, T0 + s(60));
    expect(elapsedMs(c, T0 + s(600))).toBe(s(60));
    c = start(c, T0 + s(600));
    expect(elapsedMs(c, T0 + s(630))).toBe(s(90));
  });

  it('toggle alterna pausa y marcha; pausar dos veces no cambia nada', () => {
    let c = toggle(initialClock(), T0);
    expect(c.running).toBe(true);
    c = toggle(c, T0 + s(10));
    expect(c.running).toBe(false);
    expect(pause(c, T0 + s(99))).toBe(c);
  });

  it('ajuste manual fija el tiempo y mantiene el estado de marcha', () => {
    let c = start(initialClock(), T0);
    c = setTime(c, 12 * MINUTE_MS, T0 + s(5));
    expect(c.running).toBe(true);
    expect(elapsedMs(c, T0 + s(15))).toBe(12 * MINUTE_MS + s(10));
    const paused = setTime(pause(c, T0 + s(15)), 5 * MINUTE_MS, T0 + s(20));
    expect(paused.running).toBe(false);
    expect(elapsedMs(paused, T0 + s(999))).toBe(5 * MINUTE_MS);
  });

  it('desplazamiento ±10 s, sin bajar de 0', () => {
    const c = setTime(initialClock(), s(5), T0);
    expect(elapsedMs(shift(c, s(10), T0), T0)).toBe(s(15));
    expect(elapsedMs(shift(c, -s(10), T0), T0)).toBe(0);
  });

  it('si el reloj del dispositivo retrocede no resta tiempo', () => {
    const c = start(setTime(initialClock(), s(100), T0), T0);
    expect(elapsedMs(c, T0 - s(50))).toBe(s(100));
  });

  it('no se detiene al llegar al final nominal de la parte', () => {
    const c = start(initialClock(), T0);
    expect(elapsedMs(c, T0 + 31 * MINUTE_MS)).toBe(31 * MINUTE_MS);
    expect(c.running).toBe(true);
  });
});

describe('cambio de parte', () => {
  it('la segunda parte empieza parada en 30:00', () => {
    const c = startSecondHalf(30);
    expect(c).toEqual({ period: 2, running: false, baseMs: 30 * MINUTE_MS, anchorWallMs: null });
    const running = start(c, T0);
    expect(elapsedMs(running, T0 + 2 * MINUTE_MS)).toBe(32 * MINUTE_MS);
  });
});

describe('cuenta atrás de los últimos cinco minutos', () => {
  const at = (minutes: number, seconds = 0, period: 1 | 2 = 1) =>
    countdownMs(
      { ...setTime(initialClock(), minutes * MINUTE_MS + s(seconds), T0), period },
      T0,
      30,
    );

  it('no aparece antes del minuto 25', () => {
    expect(at(24, 59)).toBeNull();
    expect(at(10, 0, 2)).toBeNull();
    expect(at(54, 59, 2)).toBeNull();
  });

  it('minuto 26:30 → quedan 3:30', () => {
    expect(at(26, 30)).toBe(3 * MINUTE_MS + s(30));
  });

  it('minuto 57:15 → quedan 2:45', () => {
    expect(at(57, 15, 2)).toBe(2 * MINUTE_MS + s(45));
  });

  it('pasado el final nominal muestra 0, nunca negativo', () => {
    expect(at(25)).toBe(5 * MINUTE_MS);
    expect(at(30)).toBe(0);
    expect(at(31, 20)).toBe(0);
    expect(at(62, 0, 2)).toBe(0);
  });
});
