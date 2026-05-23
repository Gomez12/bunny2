import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './components/ui/button';
import { UserMenu } from './components/UserMenu';
import { StatusPage } from './pages/StatusPage';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';
import { AdminGroupsPage } from './pages/admin/AdminGroupsPage';
import { bootstrapSession, useSession } from './lib/session';

type Tab = 'status' | 'chat' | 'admin-users' | 'admin-groups' | 'account';

/**
 * Top-level state machine for the web app.
 *
 *   status === 'unknown' | 'loading' → <LoadingScreen />
 *   status === 'guest'               → <LoginPage />
 *   mustChangePassword === true      → <ChangePasswordPage forced />
 *   otherwise                        → <AppShell />
 *
 * No router — `tab` lives in component state. Admin tabs only render
 * when `isAdmin` is true, so a non-admin can't even click them.
 */
export function App(): JSX.Element {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const [tab, setTab] = useState<Tab>('status');

  // Reflect the i18n locale into the document so screen readers pronounce
  // content correctly and so the browser's title bar uses the translated
  // app name.
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? 'en';
    document.title = t('common.appName');
  }, [t, i18n.resolvedLanguage]);

  // Run bootstrap once on first mount.
  useEffect(() => {
    void bootstrapSession();
  }, []);

  // When the user loses admin (or signs out), drop back to a tab they
  // are allowed to see.
  useEffect(() => {
    if (
      (tab === 'admin-users' || tab === 'admin-groups') &&
      session.status === 'authenticated' &&
      !session.isAdmin
    ) {
      setTab('status');
    }
  }, [tab, session.status, session.isAdmin]);

  if (session.status === 'unknown' || session.status === 'loading') {
    return (
      <div
        className="flex min-h-screen items-center justify-center"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
    );
  }

  if (session.status === 'guest') {
    return <LoginPage />;
  }

  if (session.mustChangePassword) {
    return <ChangePasswordPage forced />;
  }

  const isAdmin = session.isAdmin;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <h1 className="text-xl font-semibold">{t('common.appName')}</h1>
          <div className="flex items-center gap-4">
            <nav aria-label={t('common.appName')}>
              <ul className="flex flex-wrap gap-2">
                <li>
                  <Button
                    type="button"
                    variant={tab === 'status' ? 'default' : 'ghost'}
                    size="sm"
                    aria-current={tab === 'status' ? 'page' : undefined}
                    onClick={() => setTab('status')}
                  >
                    {t('nav.status')}
                  </Button>
                </li>
                <li>
                  <Button
                    type="button"
                    variant={tab === 'chat' ? 'default' : 'ghost'}
                    size="sm"
                    aria-current={tab === 'chat' ? 'page' : undefined}
                    onClick={() => setTab('chat')}
                  >
                    {t('nav.chat')}
                  </Button>
                </li>
                {isAdmin ? (
                  <li>
                    <Button
                      type="button"
                      variant={tab === 'admin-users' ? 'default' : 'ghost'}
                      size="sm"
                      aria-current={tab === 'admin-users' ? 'page' : undefined}
                      onClick={() => setTab('admin-users')}
                    >
                      {t('nav.adminUsers')}
                    </Button>
                  </li>
                ) : null}
                {isAdmin ? (
                  <li>
                    <Button
                      type="button"
                      variant={tab === 'admin-groups' ? 'default' : 'ghost'}
                      size="sm"
                      aria-current={tab === 'admin-groups' ? 'page' : undefined}
                      onClick={() => setTab('admin-groups')}
                    >
                      {t('nav.adminGroups')}
                    </Button>
                  </li>
                ) : null}
              </ul>
            </nav>
            <UserMenu onChangePassword={() => setTab('account')} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {tab === 'status' ? <StatusPage /> : null}
        {tab === 'chat' ? <ChatPage /> : null}
        {tab === 'admin-users' && isAdmin ? <AdminUsersPage /> : null}
        {tab === 'admin-groups' && isAdmin ? <AdminGroupsPage /> : null}
        {tab === 'account' ? <ChangePasswordPage onSuccess={() => setTab('status')} /> : null}
      </main>
    </div>
  );
}
