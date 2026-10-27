import type { LucideIcon, LucideProps } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from './icons';

/** Icono con el tamaño y grosor de trazo comunes. */
export function Icon({ as: Cmp, size = ICON_SIZE, ...rest }: LucideProps & { as: LucideIcon }) {
  return <Cmp size={size} strokeWidth={ICON_STROKE} aria-hidden="true" {...rest} />;
}
