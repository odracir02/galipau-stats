// Cuerpo técnico automático: tres puestos fijos en todos los equipos, que se
// ofrecen al registrar amarillas, exclusiones y rojas sin darlos de alta antes.
// El oficial de cada puesto se crea solo la primera vez que se sanciona, con un
// identificador estable por equipo del club y puesto: si dos dispositivos lo
// crean a la vez, es el mismo registro (el servidor trata la segunda alta como
// repetida) y nunca hay dos «Entrenador» del mismo equipo.
import type { Id, SquadEntry } from './types';

export type FixedOfficialSlot = 'head' | 'assistant' | 'staff';

export const FIXED_OFFICIALS: readonly { slot: FixedOfficialSlot; name: string }[] = [
  { slot: 'head', name: 'Entrenador' },
  { slot: 'assistant', name: 'Segundo entrenador' },
  { slot: 'staff', name: 'Cuerpo técnico' },
];

const PREFIX = 'oficial-';

/**
 * Identificador del oficial de un puesto. `teamKey` es el equipo del club si el
 * equipo está vinculado (el mismo en todos los dispositivos) y, si no, el local.
 */
export const fixedOfficialId = (slot: FixedOfficialSlot, teamKey: Id): Id => `${PREFIX}${slot}-${teamKey}`;

/** Puesto fijo de un oficial, o null si es un jugador o un oficial dado de alta a mano. */
export function fixedSlotOf(playerId: Id | null): FixedOfficialSlot | null {
  if (!playerId?.startsWith(PREFIX)) return null;
  const slot = FIXED_OFFICIALS.find((f) => playerId.startsWith(`${PREFIX}${f.slot}-`));
  return slot?.slot ?? null;
}

export const fixedOfficialName = (slot: FixedOfficialSlot): string => FIXED_OFFICIALS.find((f) => f.slot === slot)!.name;

/**
 * Fecha de alta de los puestos fijos: la misma en todos los dispositivos, para
 * que dos altas del mismo puesto sean exactamente el mismo registro (también en
 * su huella) y la comprobación del envío no vea diferencias.
 */
export const FIXED_OFFICIAL_SINCE = '2025-07-01T00:00:00.000Z';

/**
 * Opciones del cuerpo técnico para una sanción: los oficiales convocados y los
 * puestos fijos aún sin convocar (`fixed`, como elección pendiente de convocar).
 * Primero los puestos fijos, en su orden; después los demás oficiales por nombre.
 */
export function staffOptions(convoked: readonly SquadEntry[], fixed: readonly { slot: FixedOfficialSlot; name: string }[]): SquadEntry[] {
  const pending = fixed.map((f): SquadEntry => ({ playerId: fixedPick(f.slot), name: f.name, number: 0, position: 'field', role: 'official' }));
  const order = (s: SquadEntry) => {
    const slot = fixedSlotOf(s.playerId) ?? pickedSlot(s.playerId);
    return slot ? FIXED_OFFICIALS.findIndex((f) => f.slot === slot) : FIXED_OFFICIALS.length;
  };
  return [...convoked, ...pending].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, 'es'));
}

/** Cómo se nombra un registro de la plantilla en los mensajes (los oficiales no tienen dorsal). */
export const rosterLabel = (p: { number: number; name: string; role?: string }): string =>
  p.role === 'official' ? `Cuerpo técnico · ${p.name}` : `Jugador ${p.number} · ${p.name}`;

/** Nombre con el que se muestra un oficial: los puestos fijos ya dicen qué son. */
export const officialLabel = (s: Pick<SquadEntry, 'playerId' | 'name'>): string =>
  fixedSlotOf(s.playerId) || pickedSlot(s.playerId) ? s.name : `${s.name} · cuerpo técnico`;

/**
 * Elección de un puesto fijo en el registro o la corrección, cuando su oficial
 * aún no está convocado en el partido (se convoca al guardar).
 */
const PICK = 'puesto-fijo:';
export const fixedPick = (slot: FixedOfficialSlot): string => `${PICK}${slot}`;
export function pickedSlot(value: string | null): FixedOfficialSlot | null {
  if (!value?.startsWith(PICK)) return null;
  const slot = value.slice(PICK.length);
  return FIXED_OFFICIALS.some((f) => f.slot === slot) ? (slot as FixedOfficialSlot) : null;
}
