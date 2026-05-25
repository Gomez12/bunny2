import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Tabs, type TabDef } from '../components/ui/tabs';
import { LayerTypeBadge } from '../components/LayerTypeBadge';
import {
  addLayerVisibility,
  deleteLayer,
  getSystemLocales,
  listLayerAttachments,
  registerLayerAttachment,
  removeLayerAttachment,
  removeLayerVisibility,
  setLayerLocales,
  updateLayer,
} from '../lib/api';
import type { Layer, LayerAttachment, LayerAttachmentKind } from '../lib/api-types';
import { errorKeyOf } from '../lib/errors';
import { refreshLayers, useSession } from '../lib/session';
import { pushToast } from '../lib/toast';
import { useCurrentLayer } from '../lib/use-current-layer';
import { LayerSettingsProposalsTab } from './LayerSettingsProposalsTab';

/**
 * Layer settings — General / Members / Visibility / Locales / Attachments.
 *
 * `useCurrentLayer()` resolves the URL slug against the caller's
 * effective set. The tabs themselves are controlled via the `?tab=…`
 * query parameter so deep links from `LayerDashboardPage`'s
 * "Configure widgets" CTA land on the right pane.
 *
 * Per §4.1 the controls render disabled — not hidden — when the
 * caller lacks edit rights, so the surface stays discoverable. The
 * server still validates every mutation; `canEdit` is a UI hint only.
 *
 * Member / visibility / locales / attachments mutations refresh the
 * tab-local state without a full reload, then push a toast.
 */

const TAB_VALUES = [
  'general',
  'members',
  'visibility',
  'locales',
  'attachments',
  'proposals',
] as const;
type TabValue = (typeof TAB_VALUES)[number];

function parseTab(raw: string | null): TabValue {
  if (raw === null) return 'general';
  return (TAB_VALUES as readonly string[]).includes(raw) ? (raw as TabValue) : 'general';
}

export function LayerSettingsPage(): JSX.Element {
  const { t } = useTranslation();
  const current = useCurrentLayer();
  const [search, setSearch] = useSearchParams();
  const activeTab = parseTab(search.get('tab'));

  function setTab(next: TabValue): void {
    const params = new URLSearchParams(search);
    params.set('tab', next);
    setSearch(params, { replace: true });
  }

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  const { layer, canEdit } = current;

  const tabs: TabDef[] = [
    {
      value: 'general',
      label: t('admin.layers.detail.tabs.general'),
      panel: <GeneralTab layer={layer} canEdit={canEdit} />,
    },
    {
      value: 'members',
      label: t('admin.layers.detail.tabs.members'),
      panel: <MembersTab layer={layer} canEdit={canEdit} />,
    },
    {
      value: 'visibility',
      label: t('admin.layers.detail.tabs.visibility'),
      panel: <VisibilityTab layer={layer} canEdit={canEdit} />,
    },
    {
      value: 'locales',
      label: t('admin.layers.detail.tabs.locales'),
      panel: <LocalesTab layer={layer} canEdit={canEdit} />,
    },
    {
      value: 'attachments',
      label: t('admin.layers.detail.tabs.attachments'),
      panel: <AttachmentsTab layer={layer} canEdit={canEdit} />,
    },
    {
      value: 'proposals',
      label: t('nav.layerSettings.proposals'),
      panel: <LayerSettingsProposalsTab layer={layer} canEdit={canEdit} />,
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle>{t('admin.layers.detail.title', { name: layer.name })}</CardTitle>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LayerTypeBadge type={layer.type} />
            <span className="font-mono">{layer.slug}</span>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs
            tabs={tabs}
            value={activeTab}
            onChange={(v) => setTab(v as TabValue)}
            ariaLabel={t('admin.layers.detail.tabs.ariaLabel')}
          />
        </CardContent>
      </Card>
      <DangerZone layer={layer} canEdit={canEdit} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Danger zone — delete a project layer.

/**
 * Soft-delete UI. Hidden for personal / group / everyone layers (the
 * server rejects those with `errors.layer.notDeletable`, but there is
 * no need to surface a button that always errors). For project layers
 * the card is always rendered so the destructive action stays
 * discoverable; the button is disabled when the caller lacks edit
 * rights, mirroring the rest of the page (§4.1).
 *
 * On success we route to `/layers`. We deliberately navigate BEFORE
 * `refreshLayers()` resolves — once the current layer is gone the
 * settings page's `useCurrentLayer()` would otherwise flip to a
 * not-visible state and render nothing while the toast fires.
 */
function DangerZone(props: TabProps): JSX.Element | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  if (props.layer.type !== 'project') return null;

  async function handleConfirm(): Promise<void> {
    if (pending) return;
    setPending(true);
    setErrorKey(null);
    try {
      await deleteLayer(props.layer.slug);
      setOpen(false);
      pushToast({
        kind: 'success',
        message: t('admin.layers.delete.deleted', { name: props.layer.name }),
      });
      navigate('/layers');
      await refreshLayers();
    } catch (err: unknown) {
      setErrorKey(errorKeyOf(err));
    } finally {
      setPending(false);
    }
  }

  function handleClose(): void {
    if (pending) return;
    setOpen(false);
    setErrorKey(null);
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader className="space-y-1">
        <CardTitle className="text-destructive">{t('admin.layers.delete.cardTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('admin.layers.delete.intro')}</p>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="destructive"
            disabled={!props.canEdit || pending}
            onClick={() => setOpen(true)}
          >
            {t('admin.layers.delete.cta')}
          </Button>
        </div>
      </CardContent>
      <ConfirmDialog
        open={open}
        title={t('admin.layers.delete.confirmTitle')}
        body={t('admin.layers.delete.confirmBody', { name: props.layer.name })}
        confirmLabel={t('admin.layers.delete.cta')}
        destructive
        busy={pending}
        errorKey={errorKey}
        onConfirm={() => void handleConfirm()}
        onClose={handleClose}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tabs

interface TabProps {
  readonly layer: Layer;
  readonly canEdit: boolean;
}

function GeneralTab(props: TabProps): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState(props.layer.name);
  const [description, setDescription] = useState(props.layer.description ?? '');
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    setName(props.layer.name);
    setDescription(props.layer.description ?? '');
  }, [props.layer]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending || !props.canEdit) return;
    setPending(true);
    setErrorKey(null);
    try {
      const patch: { name?: string; description?: string | null } = {};
      if (name !== props.layer.name) patch.name = name;
      const next = description.length > 0 ? description : null;
      if (next !== props.layer.description) patch.description = next;
      if (patch.name === undefined && patch.description === undefined) {
        pushToast({ kind: 'info', message: t('admin.layers.general.noChanges') });
        return;
      }
      await updateLayer(props.layer.slug, patch);
      await refreshLayers();
      pushToast({ kind: 'success', message: t('admin.layers.general.saved') });
    } catch (err: unknown) {
      setErrorKey(errorKeyOf(err));
    } finally {
      setPending(false);
    }
  }

  const disabled = !props.canEdit || pending;
  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="layer-general-name">{t('admin.layers.general.nameLabel')}</Label>
        <Input
          id="layer-general-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled}
          required
          autoComplete="off"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="layer-general-desc">{t('admin.layers.general.descriptionLabel')}</Label>
        <Textarea
          id="layer-general-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={disabled}
          rows={3}
        />
      </div>
      {errorKey !== null ? (
        <p role="alert" aria-live="polite" className="text-sm text-destructive">
          {t(errorKey, { defaultValue: t('errors.network') })}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={disabled}>
          {t('admin.layers.general.save')}
        </Button>
      </div>
    </form>
  );
}

function MembersTab(props: TabProps): JSX.Element {
  const { t } = useTranslation();

  // Phase 3.5 deliberately does NOT ship the member-add flow because
  // there is no non-admin endpoint that lists candidate users / groups
  // to pick from. Owners get a read-only summary fetched from
  // /layers/:slug (which only returns the layer row itself today),
  // and a notice explaining the next step. The detailed
  // member-CRUD endpoints already exist server-side (3.4) — wiring up
  // a member-add UI is deferred to phase 3.6 once a non-admin
  // user/group picker exists.
  if (props.layer.type !== 'project') {
    return (
      <p className="text-sm text-muted-foreground">{t('admin.layers.members.derivedNotice')}</p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('admin.layers.members.projectNotice')}</p>
      <p className="text-xs text-muted-foreground">
        {/* TODO(phase-3.6): user/group picker + add/remove rows.
            Blocked on a non-admin lookup endpoint; tracked in the
            phase-03 plan §11. */}
        {t('admin.layers.members.followUp')}
      </p>
    </div>
  );
}

function VisibilityTab(props: TabProps): JSX.Element {
  const { t } = useTranslation();
  const session = useSession();
  const [parentSlug, setParentSlug] = useState('');
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  // Visibility list isn't exposed by the server today — the route only
  // accepts add/remove. Render the add form + a hint, surfaced as a
  // followUp note rather than calling a phantom endpoint.
  const candidates = useMemo<Layer[]>(
    () => session.layers.filter((l) => l.id !== props.layer.id),
    [session.layers, props.layer.id],
  );

  async function handleAdd(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending || !props.canEdit) return;
    if (parentSlug.length === 0) {
      setErrorKey('errors.layer.badRequest');
      return;
    }
    setPending(true);
    setErrorKey(null);
    try {
      await addLayerVisibility(props.layer.slug, {
        parentSlug,
        direction: 'bottom_up',
      });
      await refreshLayers();
      pushToast({ kind: 'success', message: t('admin.layers.visibility.added') });
      setParentSlug('');
    } catch (err: unknown) {
      setErrorKey(errorKeyOf(err));
    } finally {
      setPending(false);
    }
  }

  async function handleRemove(slug: string): Promise<void> {
    if (!props.canEdit) return;
    try {
      await removeLayerVisibility(props.layer.slug, slug);
      await refreshLayers();
      pushToast({ kind: 'success', message: t('admin.layers.visibility.removed') });
    } catch (err: unknown) {
      pushToast({ kind: 'error', message: t(errorKeyOf(err)) });
    }
  }

  const disabled = !props.canEdit || pending;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('admin.layers.visibility.intro')}</p>
      <form onSubmit={(e) => void handleAdd(e)} className="space-y-3" noValidate>
        <div className="space-y-2">
          <Label htmlFor="layer-vis-parent">{t('admin.layers.visibility.parentLabel')}</Label>
          <select
            id="layer-vis-parent"
            className="block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={parentSlug}
            onChange={(e) => setParentSlug(e.target.value)}
            disabled={disabled}
          >
            <option value="">{t('admin.layers.visibility.parentPlaceholder')}</option>
            {candidates.map((l) => (
              <option key={l.id} value={l.slug}>
                {l.name} ({l.slug})
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('admin.layers.visibility.directionLabel')}
          </span>
          <span className="rounded-md border bg-muted px-2 py-0.5 font-mono text-xs">
            {'bottom_up'}
          </span>
        </div>
        {errorKey !== null ? (
          <p role="alert" aria-live="polite" className="text-sm text-destructive">
            {t(errorKey, { defaultValue: t('errors.network') })}
          </p>
        ) : null}
        <Button type="submit" disabled={disabled}>
          {t('admin.layers.visibility.add')}
        </Button>
      </form>
      <details className="rounded-md border p-3 text-sm">
        <summary className="cursor-pointer">{t('admin.layers.visibility.removeHelp')}</summary>
        <ul className="mt-2 space-y-1">
          {candidates.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2">
              <span>
                <span className="font-medium">{l.name}</span>{' '}
                <span className="font-mono text-xs text-muted-foreground">{l.slug}</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleRemove(l.slug)}
                disabled={disabled}
              >
                {t('admin.layers.visibility.remove')}
              </Button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function LocalesTab(props: TabProps): JSX.Element {
  const { t } = useTranslation();
  const [supported, setSupported] = useState<readonly string[] | null>(null);
  const [systemDefault, setSystemDefault] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [defaultLocale, setDefaultLocale] = useState<string>('');
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getSystemLocales();
        if (cancelled) return;
        setSupported(res.locales);
        setSystemDefault(res.default);
      } catch (err: unknown) {
        if (!cancelled) setLoadError(errorKeyOf(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function togglePicked(loc: string): void {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(loc)) {
        next.delete(loc);
        if (defaultLocale === loc) setDefaultLocale('');
      } else {
        next.add(loc);
      }
      return next;
    });
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending || !props.canEdit) return;
    if (picked.size === 0) {
      setErrorKey('errors.layer.badRequest');
      return;
    }
    if (defaultLocale.length > 0 && !picked.has(defaultLocale)) {
      setErrorKey('errors.layer.defaultLocaleNotInSet');
      return;
    }
    setPending(true);
    setErrorKey(null);
    try {
      const payload: { locales: string[]; defaultLocale?: string } = {
        locales: Array.from(picked),
      };
      if (defaultLocale.length > 0) payload.defaultLocale = defaultLocale;
      await setLayerLocales(props.layer.slug, payload);
      pushToast({ kind: 'success', message: t('admin.layers.locales.saved') });
    } catch (err: unknown) {
      setErrorKey(errorKeyOf(err));
    } finally {
      setPending(false);
    }
  }

  const disabled = !props.canEdit || pending;

  if (loadError !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t(loadError, { defaultValue: t('errors.network') })}
      </p>
    );
  }
  if (supported === null) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
      <p className="text-sm text-muted-foreground">
        {t('admin.layers.locales.intro', { defaultLocale: systemDefault ?? '' })}
      </p>
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm font-medium">{t('admin.layers.locales.pickedLabel')}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {supported.map((loc) => {
            const id = `locale-pick-${loc}`;
            return (
              <div key={loc} className="flex items-center gap-2">
                <input
                  id={id}
                  type="checkbox"
                  className="h-4 w-4"
                  checked={picked.has(loc)}
                  onChange={() => togglePicked(loc)}
                  disabled={disabled}
                />
                <Label htmlFor={id} className="font-mono text-sm">
                  {loc}
                </Label>
              </div>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm font-medium">{t('admin.layers.locales.defaultLabel')}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {supported.map((loc) => {
            const id = `locale-default-${loc}`;
            const enabled = picked.has(loc);
            return (
              <div key={loc} className="flex items-center gap-2">
                <input
                  id={id}
                  type="radio"
                  name="layer-locale-default"
                  className="h-4 w-4"
                  value={loc}
                  checked={defaultLocale === loc}
                  onChange={() => setDefaultLocale(loc)}
                  disabled={disabled || !enabled}
                />
                <Label
                  htmlFor={id}
                  className={`font-mono text-sm ${enabled ? '' : 'text-muted-foreground'}`}
                >
                  {loc}
                </Label>
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
      <div className="flex justify-end">
        <Button type="submit" disabled={disabled}>
          {t('admin.layers.locales.save')}
        </Button>
      </div>
    </form>
  );
}

function AttachmentsTab(props: TabProps): JSX.Element {
  const { t } = useTranslation();
  const [attachments, setAttachments] = useState<readonly LayerAttachment[] | null>(null);
  const [kind, setKind] = useState<LayerAttachmentKind>('agent');
  const [refId, setRefId] = useState('');
  const [configText, setConfigText] = useState('{}');
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fetch the canonical attachment list from the sibling
  // GET /layers/:slug/attachments endpoint on mount and after every
  // register / remove. Phase 3's component-local state has been
  // replaced by this read; the list now survives a page reload.
  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await listLayerAttachments(props.layer.slug);
      setAttachments(list);
    } catch (err: unknown) {
      setLoadError(errorKeyOf(err));
    }
  }, [props.layer.slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending || !props.canEdit) return;
    setErrorKey(null);
    setConfigError(null);
    let parsed: Record<string, unknown> = {};
    if (configText.trim().length > 0) {
      try {
        const json: unknown = JSON.parse(configText);
        if (json === null || typeof json !== 'object' || Array.isArray(json)) {
          setConfigError('admin.layers.attachments.configMustBeObject');
          return;
        }
        parsed = json as Record<string, unknown>;
      } catch {
        setConfigError('admin.layers.attachments.configInvalidJson');
        return;
      }
    }
    if (refId.trim().length === 0) {
      setErrorKey('errors.layer.badRequest');
      return;
    }
    setPending(true);
    try {
      const created = await registerLayerAttachment(props.layer.slug, {
        kind,
        refId: refId.trim(),
        config: parsed,
      });
      setAttachments((prev) => [...(prev ?? []), created]);
      setRefId('');
      setConfigText('{}');
      pushToast({ kind: 'success', message: t('admin.layers.attachments.added') });
    } catch (err: unknown) {
      setErrorKey(errorKeyOf(err));
    } finally {
      setPending(false);
    }
  }

  async function handleRemove(a: LayerAttachment): Promise<void> {
    if (!props.canEdit) return;
    try {
      await removeLayerAttachment(props.layer.slug, a.id);
      setAttachments((prev) => (prev ?? []).filter((x) => x.id !== a.id));
      pushToast({ kind: 'success', message: t('admin.layers.attachments.removed') });
    } catch (err: unknown) {
      pushToast({ kind: 'error', message: t(errorKeyOf(err)) });
    }
  }

  const disabled = !props.canEdit || pending;

  if (loadError !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t(loadError, { defaultValue: t('errors.network') })}
      </p>
    );
  }
  if (attachments === null) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  return (
    <div className="space-y-4">
      {attachments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('admin.layers.attachments.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {attachments.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"
            >
              <div>
                <span className="font-medium">{a.refId}</span>{' '}
                <span className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                  {a.kind}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleRemove(a)}
                disabled={disabled}
              >
                {t('admin.layers.attachments.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="layer-att-kind">{t('admin.layers.attachments.kindLabel')}</Label>
            <select
              id="layer-att-kind"
              className="block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={kind}
              onChange={(e) => setKind(e.target.value as LayerAttachmentKind)}
              disabled={disabled}
            >
              <option value="agent">{t('admin.layers.attachments.kind.agent')}</option>
              <option value="skill">{t('admin.layers.attachments.kind.skill')}</option>
              <option value="mcp_server">{t('admin.layers.attachments.kind.mcp_server')}</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="layer-att-ref">{t('admin.layers.attachments.refIdLabel')}</Label>
            <Input
              id="layer-att-ref"
              value={refId}
              onChange={(e) => setRefId(e.target.value)}
              disabled={disabled}
              required
              autoComplete="off"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="layer-att-config">{t('admin.layers.attachments.configLabel')}</Label>
          <Textarea
            id="layer-att-config"
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            disabled={disabled}
            rows={4}
            aria-describedby="layer-att-config-hint"
            className="font-mono"
          />
          <p id="layer-att-config-hint" className="text-xs text-muted-foreground">
            {t('admin.layers.attachments.configHint')}
          </p>
          {configError !== null ? (
            <p role="alert" aria-live="polite" className="text-sm text-destructive">
              {t(configError)}
            </p>
          ) : null}
        </div>
        {errorKey !== null ? (
          <p role="alert" aria-live="polite" className="text-sm text-destructive">
            {t(errorKey, { defaultValue: t('errors.network') })}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={disabled}>
            {t('admin.layers.attachments.add')}
          </Button>
        </div>
      </form>
    </div>
  );
}
