import { Check, CircleAlert } from 'lucide-react';
import { dismissToast, useToasts } from '../../app/toast';
import { Icon } from './Icon';

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)}>
          {t.kind === 'error' ? <Icon as={CircleAlert} size={18} /> : <Icon as={Check} size={18} />}
          {t.text}
        </button>
      ))}
    </div>
  );
}
