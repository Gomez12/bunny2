import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { LayerTypeBadge } from '../components/LayerTypeBadge';
import { createLayer, listLayers } from '../lib/api';
import type { Layer } from '../lib/api-types';
import { errorKeyOf } from '../lib/errors';
import { refreshLayers } from '../lib/session';
import { pushToast } from '../lib/toast';

/**
 * `/layers` — browse-all-my-layers page.
 *
 * Available to every authenticated user, not just admins. The list
 * mirrors `GET /me/layers` (which is per-user-visibility-filtered by
 * the resolver). Row click navigates to `/l/:slug/dashboard`.
 *
 * The "Create project layer" button opens a focus-trapped dialog
 * (`<dialog>` element handles the trap, see `components/ui/dialog.tsx`).
 * The dialog only supports project-layer creation — all other types
 * are seeded automatically per phase 3.2. Member-pick at create time
 * is intentionally omitted because the admin user list is
 * admin-only; non-admin owners add members afterwards from
 * `LayerSettingsPage`.
 */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; errorKey: string }
  | { kind: 'ready'; layers: readonly Layer[] };

type DialogState = { kind: 'closed' } | { kind: 'create' };

export function MyLayersPage(): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' });

  const refresh = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const layers = await listLayers();
      setState({ kind: 'ready', layers });
    } catch (err: unknown) {
      setState({ kind: 'error', errorKey: errorKeyOf(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>{t('admin.layers.list.title')}</CardTitle>
          <Button type="button" onClick={() => setDialog({ kind: 'create' })}>
            {t('admin.layers.list.create')}
          </Button>
        </CardHeader>
        <CardContent>
          {state.kind === 'loading' ? (
            <p>{t('common.loading')}</p>
          ) : state.kind === 'error' ? (
            <p role="alert" className="text-destructive">
              {t(state.errorKey, { defaultValue: t('errors.network') })}
            </p>
          ) : state.layers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('admin.layers.list.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.layers.list.columns.name')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.layers.list.columns.type')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.layers.list.columns.description')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.layers.map((l) => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="px-2 py-2 font-medium">
                        <Link
                          to={`/l/${l.slug}/dashboard`}
                          className="text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {l.name}
                        </Link>
                      </td>
                      <td className="px-2 py-2">
                        <LayerTypeBadge type={l.type} />
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">{l.description ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* TODO(phase-3.6+): project-layer member count column once the
                  list response includes it; the current endpoint returns
                  Layer[] only. Adding a per-row /layers/:slug round-trip
                  here would be N+1 — omitted intentionally. */}
            </div>
          )}
        </CardContent>
      </Card>

      {dialog.kind === 'create' ? (
        <CreateLayerDialog
          onClose={() => setDialog({ kind: 'closed' })}
          onCreated={async () => {
            setDialog({ kind: 'closed' });
            await refresh();
            await refreshLayers();
            pushToast({ kind: 'success', message: t('admin.layers.create.success') });
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface CreateLayerDialogProps {
  readonly onClose: () => void;
  readonly onCreated: () => Promise<void>;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function CreateLayerDialog(props: CreateLayerDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  function handleNameChange(value: string): void {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setErrorKey(null);
    if (name.trim().length === 0 || slug.trim().length === 0) {
      setErrorKey('errors.layer.badRequest');
      return;
    }
    setPending(true);
    try {
      const payload: {
        type: 'project';
        slug: string;
        name: string;
        description?: string;
      } = { type: 'project', slug: slug.trim(), name: name.trim() };
      if (description.trim().length > 0) payload.description = description.trim();
      await createLayer(payload);
      await props.onCreated();
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
      title={t('admin.layers.create.title')}
      closeLabel={t('common.close')}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="newlayer-name">{t('admin.layers.create.name')}</Label>
          <Input
            id="newlayer-name"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            disabled={pending}
            required
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="newlayer-slug">{t('admin.layers.create.slug')}</Label>
          <Input
            id="newlayer-slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            disabled={pending}
            required
            autoComplete="off"
            aria-describedby="newlayer-slug-hint"
          />
          <p id="newlayer-slug-hint" className="text-xs text-muted-foreground">
            {t('admin.layers.create.slugHint')}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="newlayer-desc">{t('admin.layers.create.description')}</Label>
          <Textarea
            id="newlayer-desc"
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
            {t('admin.layers.create.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
