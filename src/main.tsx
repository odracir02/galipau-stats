import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { listenForInstall } from './app/install';
import { requestPersistentStorage } from './app/repo';
import './styles.css';

void requestPersistentStorage();
listenForInstall();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
