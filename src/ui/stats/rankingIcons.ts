// Icono de cada ranking (pantalla de rankings y «Mi jugador»).
import { Crosshair, Gauge, Gift, HandGrab, Lock, Shield, Target, Timer, Wind, Zap, type LucideIcon } from 'lucide-react';
import type { RankingId } from '../../stats/rankings';

export const RANKING_ICON: Record<RankingId, LucideIcon> = {
  top_scorer: Target,
  sharpshooter: Crosshair,
  wall: Shield,
  thief: HandGrab,
  repeat_offender: Timer,
  generous: Gift,
  shots: Zap,
  penalty_specialist: Gauge,
  speedster: Wind,
  penalty_stopper: Lock,
};
