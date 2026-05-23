import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { ConfirmDialog, Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  createAdminUser,
  deleteAdminUser,
  listAdminGroups,
  listAdminUsers,
  resetAdminUserPassword,
  updateAdminUser,
} from '../../lib/api';
import type { AdminGroupRow, AdminUserRow } from '../../lib/api-types';
import { errorKeyOf } from '../../lib/errors';
import { invalidateGroupsCache } from '../../lib/groups';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; errorKey: string }
  | { kind: 'ready'; users: readonly AdminUserRow[]; groups: readonly AdminGroupRow[] };

type DialogState =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; user: AdminUserRow }
  | { kind: 'delete'; user: AdminUserRow }
  | { kind: 'reset'; user: AdminUserRow }
  | { kind: 'resetResult'; username: string; generated: string };

export function AdminUsersPage(): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' });
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const [users, groups] = await Promise.all([
        listAdminUsers({ includeDeleted }),
        listAdminGroups(),
      ]);
      setState({ kind: 'ready', users, groups });
    } catch (err: unknown) {
      setState({ kind: 'error', errorKey: errorKeyOf(err) });
    }
  }, [includeDeleted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function groupNamesFor(user: AdminUserRow, groups: readonly AdminGroupRow[]): string {
    const ids = new Set(user.directGroupIds);
    return groups
      .filter((g) => ids.has(g.id))
      .map((g) => g.name)
      .join(', ');
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>{t('admin.users.title')}</CardTitle>
          <Button type="button" onClick={() => setDialog({ kind: 'create' })}>
            {t('admin.users.newUser')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              id="users-include-deleted"
              type="checkbox"
              className="h-4 w-4"
              checked={includeDeleted}
              onChange={(e) => setIncludeDeleted(e.target.checked)}
            />
            <Label htmlFor="users-include-deleted">{t('admin.users.includeDeletedToggle')}</Label>
          </div>
          {state.kind === 'loading' ? (
            <p>{t('common.loading')}</p>
          ) : state.kind === 'error' ? (
            <p role="alert" className="text-destructive">
              {t(state.errorKey, { defaultValue: t('errors.network') })}
            </p>
          ) : state.users.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('admin.users.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.users.tableHeader.username')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.users.tableHeader.displayName')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.users.tableHeader.groups')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.users.tableHeader.status')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.users.tableHeader.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.users.map((u) => (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="px-2 py-2 font-mono">{u.username}</td>
                      <td className="px-2 py-2">{u.displayName}</td>
                      <td className="px-2 py-2 text-muted-foreground">
                        {groupNamesFor(u, state.groups)}
                      </td>
                      <td className="px-2 py-2">
                        {u.deletedAt !== null
                          ? t('admin.users.status.deleted')
                          : t('admin.users.status.active')}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setDialog({ kind: 'reset', user: u })}
                          >
                            {t('admin.users.action.resetPassword')}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setDialog({ kind: 'edit', user: u })}
                          >
                            {t('admin.users.action.edit')}
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => setDialog({ kind: 'delete', user: u })}
                          >
                            {t('admin.users.action.delete')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {dialog.kind === 'create' || dialog.kind === 'edit' ? (
        <UserDialog
          mode={dialog.kind}
          user={dialog.kind === 'edit' ? dialog.user : null}
          groups={state.kind === 'ready' ? state.groups : []}
          onClose={() => setDialog({ kind: 'closed' })}
          onSaved={async (created) => {
            invalidateGroupsCache();
            await refresh();
            if (created !== null) {
              setDialog({
                kind: 'resetResult',
                username: created.username,
                generated: created.generatedPassword,
              });
            } else {
              setDialog({ kind: 'closed' });
            }
          }}
        />
      ) : null}

      {dialog.kind === 'reset' ? (
        <ResetPasswordDialog
          user={dialog.user}
          onClose={() => setDialog({ kind: 'closed' })}
          onResult={(generated) => {
            if (generated !== undefined) {
              setDialog({
                kind: 'resetResult',
                username: dialog.user.username,
                generated,
              });
            } else {
              setDialog({ kind: 'closed' });
            }
          }}
        />
      ) : null}

      {dialog.kind === 'resetResult' ? (
        <GeneratedPasswordDialog
          username={dialog.username}
          generated={dialog.generated}
          onClose={() => setDialog({ kind: 'closed' })}
        />
      ) : null}

      {dialog.kind === 'delete' ? (
        <DeleteUserDialog
          user={dialog.user}
          onClose={() => setDialog({ kind: 'closed' })}
          onDeleted={async () => {
            invalidateGroupsCache();
            await refresh();
            setDialog({ kind: 'closed' });
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents

interface UserDialogProps {
  readonly mode: 'create' | 'edit';
  readonly user: AdminUserRow | null;
  readonly groups: readonly AdminGroupRow[];
  readonly onClose: () => void;
  readonly onSaved: (created: { username: string; generatedPassword: string } | null) => void;
}

function UserDialog(props: UserDialogProps): JSX.Element {
  const { t } = useTranslation();
  const editing = props.user;
  const [username, setUsername] = useState(editing?.username ?? '');
  const [displayName, setDisplayName] = useState(editing?.displayName ?? '');
  const [initialPassword, setInitialPassword] = useState('');
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set(editing?.directGroupIds ?? []));
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  function toggleGroup(id: string): void {
    setGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setErrorKey(null);
    setPending(true);
    try {
      if (props.mode === 'create') {
        const payload: {
          username: string;
          displayName: string;
          initialPassword?: string;
          groupIds?: readonly string[];
        } = { username, displayName };
        if (initialPassword.length > 0) payload.initialPassword = initialPassword;
        if (groupIds.size > 0) payload.groupIds = Array.from(groupIds);
        const res = await createAdminUser(payload);
        if (res.generatedPassword !== undefined) {
          props.onSaved({ username: res.user.username, generatedPassword: res.generatedPassword });
        } else {
          props.onSaved(null);
        }
      } else {
        await updateAdminUser(editing!.id, {
          displayName,
          groupIds: Array.from(groupIds),
        });
        props.onSaved(null);
      }
    } catch (err: unknown) {
      setErrorKey(errorKeyOf(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={
        props.mode === 'create'
          ? t('admin.users.dialog.create.title')
          : t('admin.users.dialog.edit.title')
      }
      closeLabel={t('common.close')}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="userdlg-username">{t('admin.users.field.usernameLabel')}</Label>
          <Input
            id="userdlg-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={pending || props.mode === 'edit'}
            required
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="userdlg-displayname">{t('admin.users.field.displayNameLabel')}</Label>
          <Input
            id="userdlg-displayname"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={pending}
            required
            autoComplete="off"
          />
        </div>
        {props.mode === 'create' ? (
          <div className="space-y-2">
            <Label htmlFor="userdlg-initialpw">{t('admin.users.field.initialPasswordLabel')}</Label>
            <Input
              id="userdlg-initialpw"
              type="password"
              value={initialPassword}
              onChange={(e) => setInitialPassword(e.target.value)}
              disabled={pending}
              autoComplete="new-password"
              aria-describedby="userdlg-initialpw-hint"
            />
            <p id="userdlg-initialpw-hint" className="text-xs text-muted-foreground">
              {t('admin.users.field.initialPasswordHint')}
            </p>
          </div>
        ) : null}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('admin.users.field.groupsLabel')}</legend>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {props.groups.map((g) => {
              const id = `userdlg-grp-${g.id}`;
              return (
                <div key={g.id} className="flex items-center gap-2">
                  <input
                    id={id}
                    type="checkbox"
                    className="h-4 w-4"
                    checked={groupIds.has(g.id)}
                    onChange={() => toggleGroup(g.id)}
                    disabled={pending}
                  />
                  <Label htmlFor={id}>{g.name}</Label>
                </div>
              );
            })}
          </div>
        </fieldset>
        {errorKey !== null ? (
          <p role="alert" aria-live="polite" className="text-sm text-destructive">
            {t(errorKey, { defaultValue: t('errors.network') })}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={pending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface ResetPasswordDialogProps {
  readonly user: AdminUserRow;
  readonly onClose: () => void;
  readonly onResult: (generatedPassword: string | undefined) => void;
}

function ResetPasswordDialog(props: ResetPasswordDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [newPassword, setNewPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setErrorKey(null);
    setPending(true);
    try {
      const payload: { newPassword?: string } = {};
      if (newPassword.length > 0) payload.newPassword = newPassword;
      const res = await resetAdminUserPassword(props.user.id, payload);
      props.onResult(res.generatedPassword);
    } catch (err: unknown) {
      setErrorKey(errorKeyOf(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t('admin.users.resetPassword.title')}
      description={t('admin.users.resetPassword.body', { name: props.user.displayName })}
      closeLabel={t('common.close')}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="reset-newpw">{t('admin.users.resetPassword.newPasswordLabel')}</Label>
          <Input
            id="reset-newpw"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={pending}
            autoComplete="new-password"
            aria-describedby="reset-newpw-hint"
          />
          <p id="reset-newpw-hint" className="text-xs text-muted-foreground">
            {t('admin.users.resetPassword.newPasswordHint')}
          </p>
        </div>
        {errorKey !== null ? (
          <p role="alert" aria-live="polite" className="text-sm text-destructive">
            {t(errorKey, { defaultValue: t('errors.network') })}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="destructive" disabled={pending}>
            {t('admin.users.resetPassword.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface GeneratedPasswordDialogProps {
  readonly username: string;
  readonly generated: string;
  readonly onClose: () => void;
}

function GeneratedPasswordDialog(props: GeneratedPasswordDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.generated);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (insecure context, permissions);
      // fail silently — the value is still selectable in the input.
    }
  }

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t('admin.users.resetPassword.result')}
      description={t('admin.users.resetPassword.copyHint')}
      closeLabel={t('common.close')}
      footer={
        <Button type="button" onClick={props.onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="space-y-3">
        <p
          role="alert"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          {t('admin.users.resetPassword.warning')}
        </p>
        <div className="space-y-2">
          <Label htmlFor="gen-pw">{props.username}</Label>
          <div className="flex gap-2">
            <Input id="gen-pw" type="text" readOnly value={props.generated} className="font-mono" />
            <Button type="button" variant="outline" onClick={() => void handleCopy()}>
              {copied ? t('common.copied') : t('common.copy')}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

interface DeleteUserDialogProps {
  readonly user: AdminUserRow;
  readonly onClose: () => void;
  readonly onDeleted: () => Promise<void>;
}

function DeleteUserDialog(props: DeleteUserDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  async function handleConfirm(): Promise<void> {
    if (pending) return;
    setErrorKey(null);
    setPending(true);
    try {
      await deleteAdminUser(props.user.id);
      await props.onDeleted();
    } catch (err: unknown) {
      setErrorKey(errorKeyOf(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <ConfirmDialog
      open
      title={t('admin.users.delete.title')}
      body={t('admin.users.delete.body', { name: props.user.displayName })}
      destructive
      busy={pending}
      errorKey={errorKey}
      confirmLabel={t('common.delete')}
      onConfirm={() => void handleConfirm()}
      onClose={props.onClose}
    />
  );
}
