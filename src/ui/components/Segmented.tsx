interface SegmentedProps<T extends string | number> {
  value: T;
  options: readonly { value: T; label: string; badge?: number }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}

export function Segmented<T extends string | number>({ value, options, onChange, ariaLabel }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.badge ? <span className="badge">{o.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}
