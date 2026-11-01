// Icono de cada ranking (pantalla de rankings y «Mi jugador»).
import { Crosshair, Gift, HandGrab, Shield, Target, Timer, Zap, type LucideIcon } from 'lucide-react';
import type { RankingId } from '../../stats/rankings';

export const RANKING_ICON: Record<RankingId, LucideIcon> = {
  top_scorer: Target,
  sharpshooter: Crosshair,
  wall: Shield,
  thief: HandGrab,
  repeat_offender: Timer,
  generous: Gift,
  shots: Zap,
};
