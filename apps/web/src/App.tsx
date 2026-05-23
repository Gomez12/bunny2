import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './components/ui/button';
import { StatusPage } from './pages/StatusPage';
import { ChatPage } from './pages/ChatPage';

type Tab = 'status' | 'chat';

export function App(): JSX.Element {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<Tab>('status');

  // Reflect the i18n locale into the document so screen readers pronounce
  // content correctly and so the browser's title bar uses the translated
  // app name. Both attributes are user-facing and therefore localized.
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? 'en';
    document.title = t('common.appName');
  }, [t, i18n.resolvedLanguage]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <h1 className="text-xl font-semibold">{t('common.appName')}</h1>
          <nav aria-label={t('common.appName')}>
            <ul className="flex gap-2">
              <li>
                <Button
                  type="button"
                  variant={tab === 'status' ? 'default' : 'ghost'}
                  size="sm"
                  aria-current={tab === 'status' ? 'page' : undefined}
                  onClick={(): void => setTab('status')}
                >
                  {t('common.tabs.status')}
                </Button>
              </li>
              <li>
                <Button
                  type="button"
                  variant={tab === 'chat' ? 'default' : 'ghost'}
                  size="sm"
                  aria-current={tab === 'chat' ? 'page' : undefined}
                  onClick={(): void => setTab('chat')}
                >
                  {t('common.tabs.chat')}
                </Button>
              </li>
            </ul>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6">
        {tab === 'status' ? <StatusPage /> : <ChatPage />}
      </main>
    </div>
  );
}
