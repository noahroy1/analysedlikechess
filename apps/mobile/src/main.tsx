import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { listenForAuthLinks } from './lib/links.ts';
import { listenForAppState } from './lib/upload.ts';
import './index.css';

listenForAuthLinks();
listenForAppState();
// Simulator checks only: see check-bridge.ts.
if (import.meta.env.VITE_CHECK_BRIDGE) void import('./lib/check-bridge.ts').then((m) => m.startCheckBridge(import.meta.env.VITE_CHECK_BRIDGE));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
