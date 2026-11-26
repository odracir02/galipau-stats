import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Mismo sistema de diseño que la PWA y el panel de administración.
import '../../src/styles.css';
import './club.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
