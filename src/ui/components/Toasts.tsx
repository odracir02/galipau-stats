import { dismissToast, useToasts } from '../../app/toast';

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)}>
          {t.text}
        </button>
      ))}
    </div>
  );
}
