import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog } from '../../components/ui/dialog';
import {
  addAdminGroupMember,
  getAdminGroup,
  listAdminGroups,
  listAdminUsers,
  removeAdminGroupMember,
} from '../../lib/api';
import type {
  AdminGroupDetailResponse,
  AdminGroupRow,
  AdminUserRow,
  SafeGroup,
  SafeUser,
} from '../../lib/api-types';
import { errorKeyOf } from '../../lib/errors';
import { invalidateGroupsCache } from '../../lib/groups';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; errorKey: string }
  | { kind: 'ready'; detail: AdminGroupDetailResponse };

type Picker =
  | { kind: 'none' }
  | { kind: 'user'; users: readonly AdminUserRow[] }
  | { kind: 'group'; groups: readonly AdminGroupRow[] };

export interface GroupDetailPageProps {
  readonly groupId: string;
  readonly onBack: () => void;
}

export function GroupDetailPage(props: GroupDetailPageProps): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [picker, setPicker] = useState<Picker>({ kind: 'none' });
  const [mutationError, setMutationError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const detail = await getAdminGroup(props.groupId);
      setState({ kind: 'ready', detail });
    } catch (err: unknown) {
      setState({ kind: 'error', errorKey: errorKeyOf(err) });
    }
  }, [props.groupId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleRemoveUser(user: SafeUser): Promise<void> {
    setMutationError(null);
    try {
      await removeAdminGroupMember(props.groupId, user.id, 'user');
      invalidateGroupsCache();
      await refresh();
    } catch (err: unknown) {
      setMutationError(errorKeyOf(err));
    }
  }

  async function handleRemoveGroup(child: SafeGroup): Promise<void> {
    setMutationError(null);
    try {
      await removeAdminGroupMember(props.groupId, child.id, 'group');
      invalidateGroupsCache();
      await refresh();
    } catch (err: unknown) {
      setMutationError(errorKeyOf(err));
    }
  }

  async function openUserPicker(): Promise<void> {
    setMutationError(null);
    try {
      const users = await listAdminUsers();
      setPicker({ kind: 'user', users });
    } catch (err: unknown) {
      setMutationError(errorKeyOf(err));
    }
  }

  async function openGroupPicker(): Promise<void> {
    setMutationError(null);
    try {
      const groups = await listAdminGroups();
      setPicker({ kind: 'group', groups });
    } catch (err: unknown) {
      setMutationError(errorKeyOf(err));
    }
  }

  async function handlePick(memberId: string, kind: 'user' | 'group'): Promise<void> {
    setMutationError(null);
    try {
      if (kind === 'user') {
        await addAdminGroupMember(props.groupId, { userId: memberId });
      } else {
        await addAdminGroupMember(props.groupId, { groupId: memberId });
      }
      invalidateGroupsCache();
      setPicker({ kind: 'none' });
      await refresh();
    } catch (err: unknown) {
      setMutationError(errorKeyOf(err));
    }
  }

  if (state.kind === 'loading') {
    return (
      <Card>
        <CardContent className="pt-6">
          <p>{t('common.loading')}</p>
        </CardContent>
      </Card>
    );
  }

  if (state.kind === 'error') {
    return (
      <Card>
        <CardContent className="space-y-4 pt-6">
          <p role="alert" className="text-destructive">
            {t(state.errorKey, { defaultValue: t('errors.network') })}
          </p>
          <Button type="button" variant="ghost" onClick={props.onBack}>
            {t('admin.groups.detail.back')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { detail } = state;
  const directUserIds = new Set(detail.directUsers.map((u) => u.id));
  const directSubGroupIds = new Set(detail.directSubGroups.map((g) => g.id));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" onClick={props.onBack}>
          {t('admin.groups.detail.back')}
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.groups.detail.title', { name: detail.group.name })}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {mutationError !== null ? (
            <p role="alert" aria-live="polite" className="text-sm text-destructive">
              {t(mutationError, { defaultValue: t('errors.network') })}
            </p>
          ) : null}

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{t('admin.groups.detail.directUsers')}</h3>
              <Button type="button" size="sm" onClick={() => void openUserPicker()}>
                {t('admin.groups.detail.addUser')}
              </Button>
            </div>
            {detail.directUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('admin.groups.detail.noUsers')}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {detail.directUsers.map((u) => (
                  <li key={u.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>
                      <span className="font-mono">{u.username}</span>
                      <span className="ml-2 text-muted-foreground">{u.displayName}</span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleRemoveUser(u)}
                    >
                      {t('admin.groups.detail.remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{t('admin.groups.detail.directSubGroups')}</h3>
              <Button type="button" size="sm" onClick={() => void openGroupPicker()}>
                {t('admin.groups.detail.addSubGroup')}
              </Button>
            </div>
            {detail.directSubGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('admin.groups.detail.noSubGroups')}
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {detail.directSubGroups.map((g) => (
                  <li key={g.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>
                      <span className="font-mono">{g.slug}</span>
                      <span className="ml-2 text-muted-foreground">{g.name}</span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleRemoveGroup(g)}
                    >
                      {t('admin.groups.detail.remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t('admin.groups.detail.parentGroups')}</h3>
            {detail.parentGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('admin.groups.detail.noParents')}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {detail.parentGroups.map((g) => (
                  <li key={g.id} className="px-3 py-2 text-sm">
                    <span className="font-mono">{g.slug}</span>
                    <span className="ml-2 text-muted-foreground">{g.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </CardContent>
      </Card>

      {picker.kind === 'user' ? (
        <Dialog
          open
          onClose={() => setPicker({ kind: 'none' })}
          title={t('admin.groups.detail.pickUser')}
          closeLabel={t('common.close')}
        >
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
            {picker.users
              .filter((u) => u.deletedAt === null && !directUserIds.has(u.id))
              .map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => void handlePick(u.id, 'user')}
                  >
                    <span className="font-mono">{u.username}</span>
                    <span className="ml-2 text-muted-foreground">{u.displayName}</span>
                  </button>
                </li>
              ))}
          </ul>
        </Dialog>
      ) : null}

      {picker.kind === 'group' ? (
        <Dialog
          open
          onClose={() => setPicker({ kind: 'none' })}
          title={t('admin.groups.detail.pickGroup')}
          closeLabel={t('common.close')}
        >
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
            {picker.groups
              .filter(
                (g) =>
                  g.id !== detail.group.id && g.deletedAt === null && !directSubGroupIds.has(g.id),
              )
              .map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => void handlePick(g.id, 'group')}
                  >
                    <span className="font-mono">{g.slug}</span>
                    <span className="ml-2 text-muted-foreground">{g.name}</span>
                  </button>
                </li>
              ))}
          </ul>
        </Dialog>
      ) : null}
    </div>
  );
}
