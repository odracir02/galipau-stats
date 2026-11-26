// Navegación del panel por hash (#/…), como el panel de administración.
export const go = (hash: string) => {
  window.location.hash = hash;
};
