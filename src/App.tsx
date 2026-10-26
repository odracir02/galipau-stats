import { useRegisterSW } from 'virtual:pwa-register/react';
import { useRoute } from './app/router';
import { Toasts } from './ui/components/Toasts';
import { MatchScreen } from './ui/screens/MatchScreen';
import { NewMatchScreen } from './ui/screens/NewMatchScreen';
import { TeamScreen } from './ui/screens/TeamScreen';
import { TeamsScreen } from './ui/screens/TeamsScreen';

function UpdateBanner() {
  // registerType 'prompt': la nueva versión se aplica solo cuando el usuario lo decide.
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <div className="update-banner">
      <span>Hay una versión nueva de GalipauStats.</span>
      <button type="button" className="btn btn-sm" onClick={() => setNeedRefresh(false)}>
        Luego
      </button>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => void updateServiceWorker(true)}>
        Actualizar
      </button>
    </div>
  );
}

export function App() {
  const route = useRoute();
  let screen;
  switch (route.name) {
    case 'teams':
      screen = <TeamsScreen />;
      break;
    case 'team':
      screen = <TeamScreen key={route.teamId} teamId={route.teamId} />;
      break;
    case 'newMatch':
      screen = <NewMatchScreen key={route.teamId} teamId={route.teamId} />;
      break;
    case 'match':
      screen = <MatchScreen key={route.matchId} matchId={route.matchId} />;
      break;
  }
  return (
    <>
      <UpdateBanner />
      {screen}
      <Toasts />
    </>
  );
}
