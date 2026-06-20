import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../ui/App';
import '../ui/styles.css';
import { bootWebBridge, persistenceAvailable } from './bridge';

const root = createRoot(document.getElementById('root')!);

root.render(
  <div style={{ display: 'grid', placeItems: 'center', height: '100vh', color: '#52606d', fontFamily: 'system-ui' }}>
    Opening your books…
  </div>
);

bootWebBridge()
  .then(() => {
    document.getElementById('root')!.setAttribute('data-app', 'ready');
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
    if (!persistenceAvailable()) {
      window.setTimeout(
        () =>
          window.alert(
            'This browser is blocking local storage, so changes will NOT be saved when you close this tab.\n\nUse Settings → Backup & data → "Back up now" to download your file, and "Restore" to load it next time.'
          ),
        800
      );
    }
  })
  .catch((e) => {
    root.render(
      <div style={{ maxWidth: 520, margin: '15vh auto', fontFamily: 'system-ui', color: '#1f2933' }}>
        <h2>Couldn't open the books</h2>
        <p style={{ color: '#c0392b' }}>{String(e?.message ?? e)}</p>
        <p style={{ color: '#52606d' }}>Try a different browser (Chrome or Edge), or restore from a backup file.</p>
      </div>
    );
  });
