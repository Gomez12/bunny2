import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './index.css';
import { App } from './App';
import { configureAnalytics } from './lib/analytics';
import { httpAnalyticsSink } from './lib/analytics-http-sink';

// Phase 6 of `docs/dev/plans/admin-observability-viewer.md` — wire
// the production analytics sink. `httpAnalyticsSink` batches, retries
// on transient failure, drops on overflow, and never throws (see
// `apps/web/src/lib/analytics-http-sink.ts`). Calling here keeps the
// "once at app bootstrap" contract documented in
// `docs/dev/observability/analytics.md`.
configureAnalytics({ sink: httpAnalyticsSink });

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
