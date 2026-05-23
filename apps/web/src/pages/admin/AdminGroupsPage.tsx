import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { ConfirmDialog, Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import {
  createAdminGroup,
  deleteAdminGroup,
  listAdminGroups,
  updateAdminGroup,
} from '../../lib/api';
import type { AdminGroupRow } from '../../lib/api-types';
import { errorKeyOf } from '../../lib/errors';
import { invalidateGroupsCache } from '../../lib/groups';
import { GroupDetailPage } from './GroupDetailPage';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; errorKey: string }
  | { kind: 'ready'; groups: readonly AdminGroupRow[] };

type DialogState =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; group: AdminGroupRow }
  | { kind: 'delete'; group: AdminGroupRow };

const ADMIN_SLUG = 'admin';

export function AdminGroupsPage(): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' });
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const groups = await listAdminGroups();
      setState({ kind: 'ready', groups });
    } catch (err: unknown) {
      setState({ kind: 'error', errorKey: errorKeyOf(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (openGroupId !== null) {
    return (
      <GroupDetailPage
        groupId={openGroupId}
        onBack={() => {
          setOpenGroupId(null);
          void refresh();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>{t('admin.groups.title')}</CardTitle>
          <Button type="button" onClick={() => setDialog({ kind: 'create' })}>
            {t('admin.groups.newGroup')}
          </Button>
        </CardHeader>
        <CardContent>
          {state.kind === 'loading' ? (
            <p>{t('common.loading')}</p>
          ) : state.kind === 'error' ? (
            <p role="alert" className="text-destructive">
              {t(state.errorKey, { defaultValue: t('errors.network') })}
            </p>
          ) : state.groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('admin.groups.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.groups.tableHeader.slug')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.groups.tableHeader.name')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.groups.tableHeader.description')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.groups.tableHeader.users')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.groups.tableHeader.subGroups')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.groups.tableHeader.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.groups.map((g) => (
                    <tr key={g.id} className="border-b last:border-0">
                      <td className="px-2 py-2 font-mono">{g.slug}</td>
                      <td className="px-2 py-2">{g.name}</td>
                      <td className="px-2 py-2 text-muted-foreground">{g.description ?? ''}</td>
                      <td className="px-2 py-2">{g.directUserMemberCount}</td>
                      <td className="px-2 py-2">{g.directSubGroupCount}</td>
                      <td className="px-2 py-2">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setOpenGroupId(g.id)}
                          >
                            {t('admin.groups.action.open')}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setDialog({ kind: 'edit', group: g })}
                          >
                            {t('admin.groups.action.edit')}
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={g.slug === ADMIN_SLUG}
                            onClick={() => setDialog({ kind: 'delete', group: g })}
                          >
                            {t('admin.groups.action.delete')}
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
        <GroupDialog
          mode={dialog.kind}
          group={dialog.kind === 'edit' ? dialog.group : null}
          onClose={() => setDialog({ kind: 'closed' })}
          onSaved={async () => {
            invalidateGroupsCache();
            await refresh();
            setDialog({ kind: 'closed' });
          }}
        />
      ) : null}

      {dialog.kind === 'delete' ? (
        <DeleteGroupDialog
          group={dialog.group}
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

interface GroupDialogProps {
  readonly mode: 'create' | 'edit';
  readonly group: AdminGroupRow | null;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}

function GroupDialog(props: GroupDialogProps): JSX.Element {
  const { t } = useTranslation();
  const editing = props.group;
  const [slug, setSlug] = useState(editing?.slug ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setErrorKey(null);
    setPending(true);
    try {
      if (props.mode === 'create') {
        const payload: { slug: string; name: string; description?: string } = { slug, name };
        if (description.trim().length > 0) payload.description = description;
        await createAdminGroup(payload);
      } else {
        const patch: { name?: string; description?: string | null } = {};
        if (name !== editing!.name) patch.name = name;
        if (description !== (editing!.description ?? '')) {
          patch.description = description.length > 0 ? description : null;
        }
        if (patch.name === undefined && patch.description === undefined) {
          patch.name = name;
        }
        await updateAdminGroup(editing!.id, patch);
      }
      await props.onSaved();
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
          ? t('admin.groups.dialog.create.title')
          : t('admin.groups.dialog.edit.title')
      }
      closeLabel={t('common.close')}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="grpdlg-slug">{t('admin.groups.field.slugLabel')}</Label>
          <Input
            id="grpdlg-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={pending || props.mode === 'edit'}
            required
            autoComplete="off"
            aria-describedby="grpdlg-slug-hint"
          />
          <p id="grpdlg-slug-hint" className="text-xs text-muted-foreground">
            {t('admin.groups.field.slugHint')}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="grpdlg-name">{t('admin.groups.field.nameLabel')}</Label>
          <Input
            id="grpdlg-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            required
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="grpdlg-desc">{t('admin.groups.field.descriptionLabel')}</Label>
          <Textarea
            id="grpdlg-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={pending}
            rows={3}
          />
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
          <Button type="submit" disabled={pending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface DeleteGroupDialogProps {
  readonly group: AdminGroupRow;
  readonly onClose: () => void;
  readonly onDeleted: () => Promise<void>;
}

function DeleteGroupDialog(props: DeleteGroupDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  async function handleConfirm(): Promise<void> {
    if (pending) return;
    setErrorKey(null);
    setPending(true);
    try {
      await deleteAdminGroup(props.group.id);
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
      title={t('admin.groups.delete.title')}
      body={t('admin.groups.delete.body', { name: props.group.name })}
      destructive
      busy={pending}
      errorKey={errorKey}
      confirmLabel={t('common.delete')}
      onConfirm={() => void handleConfirm()}
      onClose={props.onClose}
    />
  );
}
