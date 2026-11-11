/**
 * Marca de GalipauStats: la rana con el balón (el icono de la app). Reutiliza
 * `pwa-192.png`, que ya está en la precaché: nítida en pantallas de alta
 * densidad y disponible sin conexión.
 */
export function LogoMark({ size = 30 }: { size?: number }) {
  return <img className="brand-mark" src="/pwa-192.png" width={size} height={size} alt="" aria-hidden="true" decoding="async" />;
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
