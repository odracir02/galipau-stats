// Copia de seguridad de los datos del dispositivo (archivo JSON). Solo lectura:
// no toca IndexedDB ni usa la red. En dos pasos porque en iPhone compartir un
// archivo debe ocurrir justo tras el toque, sin esperas previas.
import { Download, Share2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { repo } from '../../app/repo';
import { showToast } from '../../app/toast';
import { errorMessage } from '../../app/errors';
import { backupFileName, buildBackup, serializeBackup, validateBackup, type Backup } from '../../data/backup';
import { DB_VERSION } from '../../data/indexedDbRepository';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';

interface Prepared {
  file: File;
  counts: Backup['counts'];
  problems: string[];
}

type NavigatorWithShare = Navigator & { canShare?: (data: ShareData) => boolean };

/** En móviles (iPhone, Android) se guarda con la hoja de compartir del sistema; en ordenador, descarga directa. */
function canShareFile(file: File): boolean {
  const nav = navigator as NavigatorWithShare;
  return navigator.maxTouchPoints > 0 && typeof nav.share === 'function' && nav.canShare?.({ files: [file] }) === true;
}

function download(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function BackupSheet({ onClose }: { onClose: () => void }) {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prepare = async () => {
    setBusy(true);
    setError(null);
    try {
      const now = new Date();
      const backup = buildBackup(await repo.readAll(), now, DB_VERSION);
      const text = serializeBackup(backup);
      // Se valida lo que de verdad se va a guardar (el texto ya serializado).
      const problems = validateBackup(JSON.parse(text));
      setPrepared({ file: new File([text], backupFileName(now), { type: 'application/json' }), counts: backup.counts, problems });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!prepared) return;
    const { file } = prepared;
    if (canShareFile(file)) {
      try {
        await navigator.share({ files: [file], title: file.name });
        showToast('Copia lista');
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return; // cancelado por el usuario
        // Si compartir falla, se ofrece la descarga directa.
      }
    }
    download(file);
    showToast('Copia descargada');
  };

  const c = prepared?.counts;
  return (
    <Sheet title="Copia de seguridad" onClose={onClose}>
      <div className="form">
        <p className="hint">
          Guarda en un archivo todos los datos de este dispositivo: equipos, plantillas, partidos y acciones (también los
          eliminados). No cambia nada en la app y funciona sin conexión.
        </p>
        <p className="notice">
          <Icon as={ShieldCheck} size={18} />
          El archivo contiene nombres y estadísticas de jugadores. Guárdalo en un lugar privado (por ejemplo, tu carpeta de
          Archivos o un gestor de contraseñas) y no lo compartas en chats o grupos.
        </p>
        {error && <p className="form-error">{error}</p>}
        {!prepared ? (
          <button type="button" className="btn btn-primary btn-block" onClick={() => void prepare()} disabled={busy}>
            {busy ? 'Preparando…' : 'Preparar copia'}
          </button>
        ) : (
          <>
            <dl className="kv">
              <div className="kv-row">
                <dt>Equipos</dt>
                <dd>{c!.teams}</dd>
              </div>
              <div className="kv-row">
                <dt>Jugadores</dt>
                <dd>{c!.players}</dd>
              </div>
              <div className="kv-row">
                <dt>Partidos</dt>
                <dd>{c!.matches}</dd>
              </div>
              <div className="kv-row">
                <dt>Acciones</dt>
                <dd>{c!.events}</dd>
              </div>
            </dl>
            {prepared.problems.length === 0 ? (
              <p className="hint">Copia comprobada: todas las relaciones entre equipos, jugadores, partidos y acciones están completas.</p>
            ) : (
              <p className="form-error">
                La copia se ha generado, pero hay datos incompletos ({prepared.problems.length}). Guárdala igualmente: es un
                reflejo exacto de lo que hay en el dispositivo.
              </p>
            )}
            <p className="hint">Archivo: {prepared.file.name}</p>
            <button type="button" className="btn btn-primary btn-block" onClick={() => void save()}>
              <Icon as={canShareFile(prepared.file) ? Share2 : Download} />
              Guardar copia
            </button>
            {canShareFile(prepared.file) && (
              <button type="button" className="btn btn-block" onClick={() => download(prepared.file)}>
                <Icon as={Download} />
                Descargar archivo
              </button>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
