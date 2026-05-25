/**
 * Phase 4 (ui-exposure-gaps) — `/admin/users/:userId`.
 *
 * Read-only diagnostics view reachable from `AdminUsersPage` rows.
 * Shows the user profile + direct group memberships hydrated from
 * `GET /admin/users/:id`. No telemetry / no analytics — admin reads
 * only, per plan §5 Phase 4 and §9 (a11y: keyboard-reachable from the
 * list, focusable back link).
 *
 * Deliberately NOT rendered:
 *   - "Recent layers visibility" listed in the plan §5 Phase 4 bullet:
 *     the backend has no endpoint that returns the layers visible to
 *     an admin's user. Adding one is out of Phase 4 scope; logged as a
 *     deviation in the phase report so a future phase can wire it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { AdminPageShell } from '../../components/admin/AdminPageShell';
import { getAdminUser } from '../../lib/api';
import { errorKeyOf } from '../../lib/errors';
import {
  adminUserDetailView,
  userStatusLabelKey,
  type AdminUserDetailInput,
} from './admin-user-detail-page-state';

export function AdminUserDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const { userId } = useParams<{ readonly userId: string }>();
  const navigate = useNavigate();
  const [input, setInput] = useState<AdminUserDetailInput>({ status: 'loading' });

  const refresh = useCallback(async (): Promise<void> => {
    if (userId === undefined || userId === '') {
      setInput({ status: 'error', errorKey: 'errors.network' });
      return;
    }
    setInput({ status: 'loading' });
    try {
      const detail = await getAdminUser(userId);
      setInput({ status: 'ready', detail });
    } catch (err: unknown) {
      setInput({ status: 'error', errorKey: errorKeyOf(err) });
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const view = adminUserDetailView(input);

  return (
    <AdminPageShell
      title={
        view.kind === 'ready'
          ? t('admin.users.detail.title', { name: view.user.displayName })
          : t('admin.users.detail.titlePlaceholder')
      }
      back={{
        label: t('admin.users.detail.back'),
        onBack: () => navigate('/admin/users'),
      }}
    >
      {view.kind === 'loading' ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : null}

      {view.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t(view.errorKey, { defaultValue: t('errors.network') })}
        </p>
      ) : null}

      {view.kind === 'ready' ? (
        <div className="space-y-6">
          <section className="space-y-2" aria-labelledby="admin-user-profile-heading">
            <h3 id="admin-user-profile-heading" className="text-sm font-semibold">
              {t('admin.users.detail.profile')}
            </h3>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('admin.users.detail.field.username')}
                </dt>
                <dd className="font-mono">{view.user.username}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('admin.users.detail.field.displayName')}
                </dt>
                <dd>{view.user.displayName}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('admin.users.detail.field.status')}
                </dt>
                <dd>{t(userStatusLabelKey(view.user))}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('admin.users.detail.field.createdAt')}
                </dt>
                <dd className="text-sm text-muted-foreground">{view.user.createdAt}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('admin.users.detail.field.updatedAt')}
                </dt>
                <dd className="text-sm text-muted-foreground">{view.user.updatedAt}</dd>
              </div>
              {view.user.deletedAt !== null ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t('admin.users.detail.field.deletedAt')}
                  </dt>
                  <dd className="text-sm text-muted-foreground">{view.user.deletedAt}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className="space-y-2" aria-labelledby="admin-user-groups-heading">
            <h3 id="admin-user-groups-heading" className="text-sm font-semibold">
              {t('admin.users.detail.directGroups')}
            </h3>
            {!view.hasGroups ? (
              <p className="text-sm text-muted-foreground">
                {t('admin.users.detail.noDirectGroups')}
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {view.directGroups.map((g) => (
                  <li key={g.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>
                      <span className="font-mono">{g.slug}</span>
                      <span className="ml-2 text-muted-foreground">{g.name}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2" aria-labelledby="admin-user-layers-heading">
            <h3 id="admin-user-layers-heading" className="text-sm font-semibold">
              {t('admin.users.detail.layersVisibility')}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t('admin.users.detail.layersVisibilityPending')}
            </p>
          </section>
        </div>
      ) : null}
    </AdminPageShell>
  );
}
