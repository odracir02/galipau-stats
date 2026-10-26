import { StorageError } from '../data/repository';
import { ValidationError } from '../domain/validation';

/** Mensaje comprensible para el usuario a partir de cualquier error. */
export function errorMessage(error: unknown): string {
  if (error instanceof ValidationError) return error.message;
  if (error instanceof StorageError)
    return `${error.message} La acción NO se ha guardado. Comprueba el espacio libre del móvil y vuelve a intentarlo.`;
  console.error(error);
  return 'Ha ocurrido un error inesperado. La acción podría no haberse guardado.';
}
