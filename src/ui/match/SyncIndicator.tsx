// Estado discreto del envío automático: un icono en la cabecera del partido
// (sin botón ni ventana) o una línea de texto en el menú y en la ficha del
// equipo. No aparece si el equipo no envía automáticamente al club.
import { CloudAlert, CloudCheck, CloudOff, CloudUpload, type LucideIcon } from 'lucide-react';
import { autoSync } from '../../app/remote';
import { useAutoSync } from '../../app/useAutoSync';
import { formatChecked } from '../../remote/session';
import { AUTO_LABEL, type AutoStatus } from '../../remote/autosync';
import { Icon } from '../components/Icon';

const ICON: Record<Exclude<AutoStatus, 'off'>, LucideIcon> = {
  synced: CloudCheck,
  pending: CloudUpload,
  sending: CloudUpload,
  offline: CloudOff,
  attention: CloudAlert,
};

export function SyncIndicator({ teamId, variant }: { teamId: string; variant: 'icon' | 'text' }) {
  const state = useAutoSync(autoSync, teamId);
  if (state.status === 'off') return null;
  const label = `Servidor del club: ${AUTO_LABEL[state.status]}`;
  if (variant === 'icon') {
    return (
      <span className={`sync-dot sync-${state.status}`} role="status" aria-label={label} title={label}>
        <Icon as={ICON[state.status]} size={18} />
      </span>
    );
  }
  return (
    <p className={`sync-line sync-${state.status}`} role="status">
      <Icon as={ICON[state.status]} size={18} />
      <span>
        {AUTO_LABEL[state.status]}
        {state.status === 'synced' && state.lastSyncedAt ? ` · ${formatChecked(state.lastSyncedAt)}` : ''}
        {state.status === 'offline' ? ' · los cambios se guardan aquí y se enviarán al volver la conexión' : ''}
        {state.status === 'attention' && state.message ? ` · ${state.message}` : ''}
      </span>
    </p>
  );
}
