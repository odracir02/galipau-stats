// Iconografía única de la aplicación: un solo juego de iconos, mismo trazo y tamaño.
import {
  ArrowDownRight,
  ArrowUpRight,
  RectangleVertical,
  Shield,
  Target,
  type LucideIcon,
} from 'lucide-react';
import type { EventKind } from '../../domain/types';

export const ICON_SIZE = 20;
export const ICON_STROKE = 2;

export const ACTION_ICON = {
  shot: Target,
  gk: Shield,
  turnover: ArrowDownRight,
  recovery: ArrowUpRight,
  defense: RectangleVertical,
} as const;

export function iconForKind(kind: EventKind): LucideIcon {
  switch (kind) {
    case 'shot':
      return ACTION_ICON.shot;
    case 'gk_shot':
      return ACTION_ICON.gk;
    case 'turnover':
      return ACTION_ICON.turnover;
    case 'recovery':
      return ACTION_ICON.recovery;
    default:
      return ACTION_ICON.defense;
  }
}
