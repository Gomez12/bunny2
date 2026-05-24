import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { Button } from './components/ui/button';
import { UserMenu } from './components/UserMenu';
import { LayerSwitcher } from './components/LayerSwitcher';
import { Toaster } from './components/Toaster';
import { StatusPage } from './pages/StatusPage';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';
import { AdminGroupsPage } from './pages/admin/AdminGroupsPage';
import { MyLayersPage } from './pages/MyLayersPage';
import { LayerSettingsPage } from './pages/LayerSettingsPage';
import { LayerDashboardPage } from './pages/LayerDashboardPage';
import { CalendarEventDetailPage } from './pages/CalendarEventDetailPage';
import { CalendarPage } from './pages/CalendarPage';
import { CompaniesListPage } from './pages/CompaniesListPage';
import { CompanyDetailPage } from './pages/CompanyDetailPage';
import { ContactDetailPage } from './pages/ContactDetailPage';
import { ContactsImportPage } from './pages/ContactsImportPage';
import { ContactsListPage } from './pages/ContactsListPage';
import { bootstrapSession, useSession } from './lib/session';

/**
 * Top-level state machine for the web app.
 *
 *   status === 'unknown' | 'loading' | 'loading-layers' → <LoadingScreen />
 *   status === 'guest'                                  → <LoginPage />
 *   mustChangePassword === true                         → <ChangePasswordPage forced />
 *   otherwise                                           → <AppShell />
 *
 * Routing is React-Router v6. The `/l/:layerSlug/*` subtree carries
 * every layer-scoped page; layer-agnostic routes (`/`, `/layers`,
 * `/admin/*`, `/account`) sit alongside it. `/` redirects to the
 * caller's personal-layer dashboard once `session.personalLayerSlug`
 * is known.
 */
export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <AppRoot />
    </BrowserRouter>
  );
}

function AppRoot(): JSX.Element {
  const { t, i18n } = useTranslation();
  const session = useSession();

  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? 'en';
    document.title = t('common.appName');
  }, [t, i18n.resolvedLanguage]);

  useEffect(() => {
    void bootstrapSession();
  }, []);

  if (
    session.status === 'unknown' ||
    session.status === 'loading' ||
    session.status === 'loading-layers'
  ) {
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
    return (
      <>
        <LoginPage />
        <Toaster />
      </>
    );
  }

  if (session.mustChangePassword) {
    return (
      <>
        <ChangePasswordPage forced />
        <Toaster />
      </>
    );
  }

  return <AppShell />;
}

function AppShell(): JSX.Element {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = session.isAdmin;

  // Used by the page-title in <header> to surface the current layer
  // alongside the route's logical name.
  const pageTitle = pageTitleFor(location.pathname, t);

  function nav(to: string): void {
    navigate(to);
  }

  function active(prefix: string): boolean {
    return location.pathname === prefix || location.pathname.startsWith(prefix + '/');
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{t('common.appName')}</h1>
            {pageTitle !== null ? (
              <span
                aria-label={t('layer.shell.pageTitleLabel')}
                className="text-sm text-muted-foreground"
              >
                {pageTitle}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-4">
            <nav aria-label={t('common.appName')}>
              <ul className="flex flex-wrap gap-2">
                <li>
                  <Button
                    type="button"
                    variant={active('/status') ? 'default' : 'ghost'}
                    size="sm"
                    aria-current={active('/status') ? 'page' : undefined}
                    onClick={() => nav('/status')}
                  >
                    {t('nav.status')}
                  </Button>
                </li>
                <li>
                  <Button
                    type="button"
                    variant={active('/chat') ? 'default' : 'ghost'}
                    size="sm"
                    aria-current={active('/chat') ? 'page' : undefined}
                    onClick={() => nav('/chat')}
                  >
                    {t('nav.chat')}
                  </Button>
                </li>
                <li>
                  <Button
                    type="button"
                    variant={active('/layers') ? 'default' : 'ghost'}
                    size="sm"
                    aria-current={active('/layers') ? 'page' : undefined}
                    onClick={() => nav('/layers')}
                  >
                    {t('nav.layers')}
                  </Button>
                </li>
                {isAdmin ? (
                  <li>
                    <Button
                      type="button"
                      variant={active('/admin/users') ? 'default' : 'ghost'}
                      size="sm"
                      aria-current={active('/admin/users') ? 'page' : undefined}
                      onClick={() => nav('/admin/users')}
                    >
                      {t('nav.adminUsers')}
                    </Button>
                  </li>
                ) : null}
                {isAdmin ? (
                  <li>
                    <Button
                      type="button"
                      variant={active('/admin/groups') ? 'default' : 'ghost'}
                      size="sm"
                      aria-current={active('/admin/groups') ? 'page' : undefined}
                      onClick={() => nav('/admin/groups')}
                    >
                      {t('nav.adminGroups')}
                    </Button>
                  </li>
                ) : null}
              </ul>
            </nav>
            <LayerSwitcher />
            <UserMenu onChangePassword={() => nav('/account')} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/status" element={<StatusPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/layers" element={<MyLayersPage />} />
          <Route
            path="/account"
            element={<ChangePasswordPage onSuccess={() => nav('/status')} />}
          />
          {isAdmin ? <Route path="/admin/users" element={<AdminUsersPage />} /> : null}
          {isAdmin ? <Route path="/admin/groups" element={<AdminGroupsPage />} /> : null}
          <Route path="/l/:layerSlug/dashboard" element={<LayerDashboardPage />} />
          <Route path="/l/:layerSlug/settings" element={<LayerSettingsPage />} />
          <Route path="/l/:layerSlug/companies" element={<CompaniesListPage />} />
          <Route path="/l/:layerSlug/companies/new" element={<CompaniesListPage />} />
          <Route path="/l/:layerSlug/companies/:companySlug" element={<CompanyDetailPage />} />
          <Route path="/l/:layerSlug/contacts" element={<ContactsListPage />} />
          <Route path="/l/:layerSlug/contacts/new" element={<ContactsListPage />} />
          <Route path="/l/:layerSlug/contacts/import" element={<ContactsImportPage />} />
          <Route path="/l/:layerSlug/contacts/:contactSlug" element={<ContactDetailPage />} />
          <Route path="/l/:layerSlug/calendar" element={<CalendarPage />} />
          <Route path="/l/:layerSlug/calendar/new" element={<CalendarPage />} />
          <Route path="/l/:layerSlug/calendar/:eventSlug" element={<CalendarEventDetailPage />} />
          <Route path="/l/:layerSlug" element={<LayerSlugIndexRedirect />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Toaster />
    </div>
  );
}

function RootRedirect(): JSX.Element {
  const session = useSession();
  if (session.personalLayerSlug !== null) {
    return <Navigate to={`/l/${session.personalLayerSlug}/dashboard`} replace />;
  }
  // No personal layer (edge case — seed not propagated, or admin
  // route blocked /me/layers). Land on the layer list rather than
  // looping.
  return <Navigate to="/layers" replace />;
}

function LayerSlugIndexRedirect(): JSX.Element {
  const location = useLocation();
  const slug = location.pathname.split('/')[2] ?? '';
  return <Navigate to={`/l/${slug}/dashboard`} replace />;
}

function NotFound(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('common.notFound')}</p>
      <Link to="/" className="underline-offset-2 hover:underline">
        {t('common.backHome')}
      </Link>
    </div>
  );
}

function pageTitleFor(pathname: string, t: (k: string) => string): string | null {
  if (pathname.startsWith('/l/')) {
    const parts = pathname.split('/');
    const sub = parts[3];
    if (sub === 'dashboard') return t('layer.shell.subpages.dashboard');
    if (sub === 'settings') return t('layer.shell.subpages.settings');
    if (sub === 'companies') return t('layer.shell.subpages.companies');
    if (sub === 'contacts') return t('layer.shell.subpages.contacts');
    if (sub === 'calendar') return t('layer.shell.subpages.calendar');
    return null;
  }
  if (pathname.startsWith('/layers')) return t('admin.layers.list.title');
  if (pathname.startsWith('/status')) return t('nav.status');
  if (pathname.startsWith('/chat')) return t('nav.chat');
  if (pathname.startsWith('/admin/users')) return t('nav.adminUsers');
  if (pathname.startsWith('/admin/groups')) return t('nav.adminGroups');
  if (pathname.startsWith('/account')) return t('auth.changePassword.title');
  return null;
}
