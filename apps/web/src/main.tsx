import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './index.css';
import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');

const root = createRoot(rootEl);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dev-only: surface axe-core accessibility violations in the browser
// console. Dynamic import so the prod bundle never includes it.
if (import.meta.env.DEV) {
  void (async (): Promise<void> => {
    const [{ default: axe }, React, ReactDOM] = await Promise.all([
      import('@axe-core/react'),
      import('react'),
      import('react-dom'),
    ]);
    axe(React, ReactDOM, 1000);
  })();
}
