import { CircleCheck, Compass, Download, EllipsisVertical, Globe, Info, Share, SquarePlus, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import {
  detectPlatform,
  deviceHints,
  isOtherIosBrowser,
  isStandalone,
  promptInstall,
  useInstallState,
  type InstallPlatform,
} from '../../app/install';
import { navigate } from '../../app/router';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Segmented';
import { TopBar } from '../components/TopBar';

interface Step {
  icon: LucideIcon;
  title: string;
  detail?: string;
}

const STEPS: Record<InstallPlatform, Step[]> = {
  ios: [
    { icon: Compass, title: 'Abre GalipauStats en Safari' },
    {
      icon: Share,
      title: 'Toca el botón Compartir',
      detail: 'En iPhone suele estar en la barra de abajo; en iPad, arriba a la derecha. Si no lo ves, búscalo en el menú ···.',
    },
    { icon: SquarePlus, title: 'Elige «Añadir a pantalla de inicio»', detail: 'Si no aparece, desliza la lista hacia abajo.' },
    { icon: CircleCheck, title: 'Confirma con «Añadir»' },
  ],
  android: [
    { icon: Globe, title: 'Abre GalipauStats en Chrome' },
    { icon: EllipsisVertical, title: 'Abre el menú del navegador', detail: 'Los tres puntos, arriba a la derecha.' },
    { icon: Download, title: 'Elige «Instalar aplicación» o «Añadir a pantalla de inicio»' },
    { icon: CircleCheck, title: 'Confirma con «Instalar» o «Añadir»' },
  ],
};

const PLATFORMS = [
  { value: 'ios', label: 'iPhone / iPad' },
  { value: 'android', label: 'Android' },
] as const;

const home = () => navigate({ name: 'teams' });

export function InstallScreen() {
  const hints = deviceHints();
  const detected = detectPlatform(hints);
  const [platform, setPlatform] = useState<InstallPlatform>(detected ?? 'ios');
  const standalone = isStandalone();
  const [otherDevice, setOtherDevice] = useState(false);
  const install = useInstallState();
  const [declined, setDeclined] = useState(false);

  const askBrowser = async () => {
    if (!(await promptInstall())) setDeclined(true);
  };

  const installed = standalone || install.installed;
  return (
    <div className="screen">
      <TopBar title="Instalar GalipauStats" subtitle="En la pantalla de inicio, como una aplicación" back={home} />
      <main className="content">
        {installed && (
          <div className="install-done" role="status">
            <Icon as={CircleCheck} size={28} />
            <div>
              <strong>{standalone ? 'GalipauStats ya está instalada' : 'GalipauStats se ha instalado'}</strong>
              <span>
                {standalone
                  ? 'La estás usando desde la pantalla de inicio. No hace falta hacer nada más.'
                  : 'Ábrela desde su icono en la pantalla de inicio.'}
              </span>
            </div>
          </div>
        )}

        {installed && !otherDevice && (
          <button type="button" className="btn btn-ghost btn-block" onClick={() => setOtherDevice(true)}>
            Ver cómo instalarla en otro dispositivo
          </button>
        )}

        {(!installed || otherDevice) && (
          <>
            <Segmented value={platform} options={PLATFORMS} onChange={setPlatform} ariaLabel="Tipo de dispositivo" />
            {!installed && !detected && <p className="hint">Elige el tipo de dispositivo en el que quieres instalarla.</p>}

            {!installed && platform === 'ios' && detected === 'ios' && isOtherIosBrowser(hints.userAgent) && (
              <p className="notice">
                <Icon as={Info} size={18} />
                Estás en otro navegador. Para seguir estos pasos, abre esta misma dirección en Safari.
              </p>
            )}

            {!installed && platform === 'android' && install.canPrompt && (
              <div className="install-quick">
                <button type="button" className="btn btn-primary btn-block" onClick={() => void askBrowser()}>
                  <Icon as={Download} />
                  Instalar ahora
                </button>
                <p className="hint">Se abrirá el aviso de instalación del navegador. También puedes seguir los pasos.</p>
              </div>
            )}
            {!installed && platform === 'android' && declined && (
              <p className="hint">No se ha instalado. Puedes hacerlo cuando quieras siguiendo los pasos.</p>
            )}

            <ol className="install-steps">
              {STEPS[platform].map((s, i) => (
                <li key={s.title}>
                  <span className="install-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <Icon as={s.icon} size={22} className="install-icon" />
                  <span className="install-text">
                    <strong>{s.title}</strong>
                    {s.detail && <span>{s.detail}</span>}
                  </span>
                </li>
              ))}
            </ol>

            <p className="hint">
              Después, abre GalipauStats desde su icono en la pantalla de inicio. Los nombres de las opciones pueden variar según el
              navegador y su versión.
            </p>
          </>
        )}

        <button type="button" className="btn btn-block" onClick={home}>
          Volver al inicio
        </button>
      </main>
    </div>
  );
}
