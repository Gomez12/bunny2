import { appName, appVersion } from '@bunny2/shared';

export function App() {
  return (
    <main>
      <h1>{appName}</h1>
      <p>
        Version <code>{appVersion}</code> — phase 1.1 skeleton.
      </p>
    </main>
  );
}
