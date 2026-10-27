/** Marca de GalipauStats: balón estilizado. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="var(--c-accent)" />
      <path
        d="M2.5 16h27M10 3.8c4.2 5.4 4.2 19 0 24.4M22 3.8c-4.2 5.4-4.2 19 0 24.4"
        stroke="var(--c-on-accent)"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <LogoMark />
      <span className="brand-name">
        Galipau<span>Stats</span>
      </span>
    </span>
  );
}
