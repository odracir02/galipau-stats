// Punto de entrada del Worker. Solo exporta el manejador: con archivos
// estáticos configurados, el runtime trata cada exportación con nombre de este
// módulo como un punto de entrada y rechaza las que no lo son. La lógica y el
// resto de exportaciones están en app.ts.
import { handle } from './app';

export type { Env } from './app';

export default {
  fetch: handle,
};
