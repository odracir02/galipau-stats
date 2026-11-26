// Panel de clubes de GalipauStats: acceso por correo (código de seis cifras), alta de
// club y primer panel para propietarios y administradores. Independiente de la PWA
// deportiva (entrenadores y consulta) y del panel de superadministración (/admin).
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ApiError, getAccount, getConfig, signOut } from './api';
import { parseRoute, type Account, type PublicConfig } from './format';
import { ClubPanel, Home } from './panel';
import { CreateClub, Login, Welcome } from './screens';
import { go } from './nav';
import { ErrorBox, Header, Loading, Page } from './ui';

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};
const getHash = () => window.location.hash;

export function App() {
  const route = parseRoute(useSyncExternalStore(subscribe, getHash));
  const [config, setConfig] = useState<PublicConfig | null>(null);
  // undefined = cargando; null = sin sesión.
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [fatal, setFatal] = useState<string | null>(null);
  // Aviso que se muestra en el inicio tras una operación hecha en otra pantalla.
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setAccount(await getAccount());
  }, []);

  useEffect(() => {
    Promise.all([getConfig(), getAccount()]).then(
      ([c, a]) => {
        setConfig(c);
        setAccount(a);
      },
      (e: unknown) => setFatal(e instanceof ApiError ? e.message : 'No se ha podido conectar con el servidor.'),
    );
  }, []);

  // Al volver al inicio se pide de nuevo la cuenta: clubes e invitaciones pueden
  // haber cambiado (una invitación nueva, un club creado en otro dispositivo…).
  const atHome = route.name === 'home';
  const signedIn = !!account;
  useEffect(() => {
    if (!atHome || !signedIn) return;
    let cancelled = false;
    getAccount().then(
      (a) => !cancelled && setAccount(a),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [atHome, signedIn]);

  const leave = async () => {
    try {
      await signOut();
    } finally {
      // Aunque falle la red, la interfaz deja de mostrar datos de la cuenta.
      setAccount(null);
      setFlash(null);
      go('#/');
    }
  };

  if (fatal) {
    return (
      <Page header={<Header />}>
        <ErrorBox message={fatal} />
        <button type="button" className="btn btn-block" onClick={() => window.location.reload()}>
          Reintentar
        </button>
      </Page>
    );
  }
  if (!config || account === undefined) return <Page header={<Header />}>{<Loading />}</Page>;

  const header = <Header email={account?.user.email} onSignOut={account ? leave : undefined} />;

  // Sin sesión: bienvenida o acceso (también para crear club o abrir uno).
  if (!account) {
    if (route.name === 'home') {
      return (
        <Page header={header}>
          <Welcome config={config} />
        </Page>
      );
    }
    return (
      <Page header={header}>
        <Login config={config} then={route.name === 'create' || (route.name === 'login' && route.then === 'create') ? 'create' : 'home'} onSignedIn={refresh} />
      </Page>
    );
  }

  // Ya hay sesión: se sigue donde iba.
  if (route.name === 'login') return <Redirect to={route.then === 'create' ? '#/crear' : '#/'} />;

  if (route.name === 'create') {
    return (
      <Page header={header}>
        {config.publicSignup ? <CreateClub onCreated={refresh} /> : <ErrorBox message="El alta de clubes todavía no está abierta." />}
      </Page>
    );
  }

  if (route.name === 'club') {
    return (
      <Page header={header}>
        <ClubPanel
          key={route.clubId}
          account={account}
          clubId={route.clubId}
          section={route.section}
          onAccountChanged={refresh}
          onLeft={(message) => {
            // Primero la cuenta actualizada (sin ese club); después, el inicio con el aviso.
            void refresh()
              .catch(() => undefined)
              .then(() => {
                setFlash(message);
                go('#/');
              });
          }}
        />
      </Page>
    );
  }

  return (
    <Page header={header}>
      <Home account={account} config={config} onChanged={refresh} flash={flash} onDismissFlash={() => setFlash(null)} />
    </Page>
  );
}

function Redirect({ to }: { to: string }) {
  useEffect(() => go(to), [to]);
  return null;
}
