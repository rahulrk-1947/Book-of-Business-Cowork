import React from 'react';
import { createRoot } from 'react-dom/client';
import ServerShell from './ServerShell';
import '../ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ServerShell />
  </React.StrictMode>
);
