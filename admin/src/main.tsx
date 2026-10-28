import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Mismo sistema de diseño que la PWA (tokens, tipografía, componentes base).
import '../../src/styles.css';
import './admin.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
