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
import { AdminNav } from './components/admin/AdminNav';
import { Button } from './components/ui/button';
import { UserMenu } from './components/UserMenu';
import { LayerSwitcher } from './components/LayerSwitcher';
import { Toaster } from './components/Toaster';
import { StatusPage } from './pages/StatusPage';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';
import { AdminUserDetailPage } from './pages/admin/AdminUserDetailPage';
import { AdminGroupsPage } from './pages/admin/AdminGroupsPage';
import { AdminScheduledTasksPage } from './pages/admin/AdminScheduledTasksPage';
import { AdminScheduledTaskRunsPage } from './pages/admin/AdminScheduledTaskRunsPage';
import { AdminBusDlqPage } from './pages/admin/AdminBusDlqPage';
import { AdminEventsPage } from './pages/admin/AdminEventsPage';
import { AdminLlmCallsPage } from './pages/admin/AdminLlmCallsPage';
import { ScheduledTasksListPage } from './pages/ScheduledTasksListPage';
import { MyLayersPage } from './pages/MyLayersPage';
import { LayerSettingsPage } from './pages/LayerSettingsPage';
import { LayerChatBoardPage } from './pages/LayerChatBoardPage';
import { LayerChatPage } from './pages/LayerChatPage';
import { LayerDashboardPage } from './pages/LayerDashboardPage';
import { CalendarEventDetailPage } from './pages/CalendarEventDetailPage';
import { CalendarPage } from './pages/CalendarPage';
import { CompaniesListPage } from './pages/CompaniesListPage';
import { CompanyDetailPage } from './pages/CompanyDetailPage';
import { ContactDetailPage } from './pages/ContactDetailPage';
import { ContactsImportPage } from './pages/ContactsImportPage';
import { ContactsListPage } from './pages/ContactsListPage';
import { TodoDetailPage } from './pages/TodoDetailPage';
import { TodosPage } from './pages/TodosPage';
import { WhiteboardDetailPage } from './pages/WhiteboardDetailPage';
import { WhiteboardsListPage } from './pages/WhiteboardsListPage';
import { LayerProposalsListPage } from './pages/LayerProposalsListPage';
import { LayerProposalDetailPage } from './pages/LayerProposalDetailPage';
import { LayerCapabilitiesPage } from './pages/LayerCapabilitiesPage';
import { bootstrapSession, useSession } from './lib/session';
import { applyTheme, getThemeSnapshot, subscribeToSystemTheme } from './lib/theme';

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

  // Theme: the inline bootstrap script in `index.html` handled the
  // initial paint. Re-apply on mount so the React-owned store, the
  // Electron bridge, and the `.dark` class agree, then subscribe to
  // OS-level changes so a `'system'` preference keeps tracking the OS
  // while the app is running. See
  // `docs/dev/follow-ups/done/dark-light-mode.md`.
  applyTheme(getThemeSnapshot());
  useEffect(() => {
    return subscribeToSystemTheme(() => {
      const pref = getThemeSnapshot();
      if (pref === 'system') applyTheme(pref);
    });
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
                <LayerScopedNavLinks navigate={nav} active={active} t={t} />
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
                    <AdminNav />
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
          {isAdmin ? <Route path="/admin/users/:userId" element={<AdminUserDetailPage />} /> : null}
          {isAdmin ? <Route path="/admin/groups" element={<AdminGroupsPage />} /> : null}
          {isAdmin ? (
            <Route path="/admin/scheduled-tasks" element={<AdminScheduledTasksPage />} />
          ) : null}
          {isAdmin ? (
            <Route
              path="/admin/scheduled-tasks/:taskId/runs"
              element={<AdminScheduledTaskRunsPage />}
            />
          ) : null}
          {isAdmin ? <Route path="/admin/bus/dlq" element={<AdminBusDlqPage />} /> : null}
          {isAdmin ? (
            <Route path="/admin/observability/events" element={<AdminEventsPage />} />
          ) : null}
          {isAdmin ? (
            <Route path="/admin/observability/llm-calls" element={<AdminLlmCallsPage />} />
          ) : null}
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
          <Route path="/l/:layerSlug/todos" element={<TodosPage />} />
          <Route path="/l/:layerSlug/todos/new" element={<TodosPage />} />
          <Route path="/l/:layerSlug/todos/:todoSlug" element={<TodoDetailPage />} />
          <Route path="/l/:layerSlug/whiteboards" element={<WhiteboardsListPage />} />
          <Route path="/l/:layerSlug/whiteboards/new" element={<WhiteboardsListPage />} />
          <Route
            path="/l/:layerSlug/whiteboards/:whiteboardSlug"
            element={<WhiteboardDetailPage />}
          />
          <Route path="/l/:layerSlug/scheduled-tasks" element={<ScheduledTasksListPage />} />
          <Route path="/l/:layerSlug/chat" element={<LayerChatPage />} />
          <Route path="/l/:layerSlug/chat/board" element={<LayerChatBoardPage />} />
          <Route path="/l/:layerSlug/proposals" element={<LayerProposalsListPage />} />
          <Route path="/l/:layerSlug/proposals/:id" element={<LayerProposalDetailPage />} />
          <Route path="/l/:layerSlug/capabilities" element={<LayerCapabilitiesPage />} />
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

/**
 * Phase 7.6 — show layer-scoped nav links (Proposals + Capabilities)
 * only when the user is currently on a `/l/:slug/*` page. Avoids
 * dangling links when the user is in a non-layer-scoped route.
 */
function LayerScopedNavLinks({
  navigate,
  active,
  t,
}: {
  readonly navigate: (to: string) => void;
  readonly active: (prefix: string) => boolean;
  readonly t: (k: string) => string;
}): JSX.Element | null {
  const location = useLocation();
  if (!location.pathname.startsWith('/l/')) return null;
  const slug = location.pathname.split('/')[2] ?? '';
  if (slug === '') return null;
  const proposalsPath = `/l/${slug}/proposals`;
  const capabilitiesPath = `/l/${slug}/capabilities`;
  return (
    <>
      <li>
        <Button
          type="button"
          variant={active(proposalsPath) ? 'default' : 'ghost'}
          size="sm"
          aria-current={active(proposalsPath) ? 'page' : undefined}
          onClick={() => navigate(proposalsPath)}
        >
          {t('nav.proposals')}
        </Button>
      </li>
      <li>
        <Button
          type="button"
          variant={active(capabilitiesPath) ? 'default' : 'ghost'}
          size="sm"
          aria-current={active(capabilitiesPath) ? 'page' : undefined}
          onClick={() => navigate(capabilitiesPath)}
        >
          {t('nav.capabilities')}
        </Button>
      </li>
    </>
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
    if (sub === 'todos') return t('layer.shell.subpages.todos');
    if (sub === 'whiteboards') return t('entity.whiteboards.list.title');
    if (sub === 'scheduled-tasks') return t('layer.shell.subpages.scheduledTasks');
    if (sub === 'chat') return t('nav.chat');
    if (sub === 'proposals') return t('layer.shell.subpages.proposals');
    if (sub === 'capabilities') return t('layer.shell.subpages.capabilities');
    return null;
  }
  if (pathname.startsWith('/layers')) return t('admin.layers.list.title');
  if (pathname.startsWith('/status')) return t('nav.status');
  if (pathname.startsWith('/chat')) return t('nav.chat');
  if (pathname.startsWith('/admin/users')) return t('nav.adminUsers');
  if (pathname.startsWith('/admin/groups')) return t('nav.adminGroups');
  if (pathname.startsWith('/admin/scheduled-tasks'))
    return t('layer.shell.subpages.adminScheduledTasks');
  if (pathname.startsWith('/admin/bus/dlq')) return t('layer.shell.subpages.adminBusDlq');
  if (pathname.startsWith('/admin/observability/events')) return t('admin.events.title');
  if (pathname.startsWith('/admin/observability/llm-calls')) return t('admin.llmCalls.title');
  if (pathname.startsWith('/account')) return t('auth.changePassword.title');
  return null;
}
