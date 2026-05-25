import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { RestoreBanner } from '../components/ui/restore-banner';
import {
  getWhiteboard,
  patchWhiteboard,
  patchWhiteboardCheckpoint,
  restoreEntity,
  softDeleteWhiteboard,
} from '../lib/api';
import { trackEvent } from '../lib/analytics';
import type { ExcalidrawElement, ExcalidrawFileEntry, WhiteboardPayload } from '../lib/api-types';
import { i18nKeysForKind, isSoftDeleted, restoreTelemetryName } from '../lib/entity-restore';
import { errorKeyOf } from '../lib/errors';
import { formatRelativeTime } from '../lib/relative-time';
import { pushToast } from '../lib/toast';
import { useSession } from '../lib/session';
import { useCurrentLayer } from '../lib/use-current-layer';
import { webWhiteboardsPath } from '../lib/whiteboards-routes';
import {
  shouldShowLockBanner,
  whiteboardDetailLoadInitial,
  whiteboardDetailView,
  type WhiteboardDetailLoad,
} from './whiteboard-detail-page-state';

/**
 * `/l/:layerSlug/whiteboards/:whiteboardSlug` — phase 11.5 detail
 * page with embedded Excalidraw canvas.
 *
 * Key responsibilities:
 *  - Lazy-load `@excalidraw/excalidraw` so the main bundle stays
 *    light. The lazy boundary uses a named-export shim — the package
 *    exports `Excalidraw` as a named export, not a default, so the
 *    `React.lazy` factory remaps it on the fly.
 *  - Debounced save: every `onChange` schedules a 2-second-idle save
 *    that PATCHes the dedicated `_checkpoint` endpoint with the scene,
 *    a freshly-rendered PNG thumbnail (via `exportToBlob`), and a
 *    stable etag (SHA-256 of the bytes). The server stores the bytes
 *    in `thumbnail_blob` + `thumbnail_etag` and bumps
 *    `last_checkpoint_at`.
 *  - Explicit "Save version" button forces an immediate checkpoint.
 *    Per ADR 0028 every checkpoint bumps `version` via the §4.0 store.
 *  - Export menu wires `exportToBlob({ mimeType: 'image/png' })` and
 *    `exportToSvg(...)` and offers the result as a downloadable blob.
 *    SVG is NEVER injected into the DOM (plan §7 Security: stored-XSS
 *    via inline SVG).
 *  - Lock banner: non-blocking. When a subsequent fetch shows the
 *    server's `updatedAt` is newer than the load snapshot and the
 *    `updatedBy` differs from the current user, the banner offers a
 *    Reload affordance. Reload is the user's choice; saves continue
 *    to work (last writer wins).
 *  - Library-import + Excalidraw's built-in export UI are DISABLED
 *    via `UIOptions.canvasActions` so the trust boundary stays narrow
 *    (plan §7 Security). The wrapper supplies the export menu.
 *  - `langCode` is passed through from the i18n context so the canvas
 *    tooltips localize alongside the wrapper.
 *
 * Accessibility (wrapper-level only — Excalidraw upstream owns canvas
 * a11y; the upstream audit is 11.6's task):
 *  - Visible focus on every wrapper button.
 *  - Labelled toolbar buttons (save version, export menu items,
 *    delete, rename).
 *  - Escape from the export menu returns focus to the trigger.
 *  - Lock banner has `role="status" aria-live="polite"`.
 *  - Save-error banner has `role="alert"`.
 *  - The Excalidraw canvas itself is wrapped in a `<div>` with a
 *    `tabIndex={-1}` so screen readers don't tab through hundreds of
 *    canvas children (upstream lacks a `role="application"` boundary
 *    — see 11.6 audit).
 */

interface ExcalidrawModuleShape {
  readonly Excalidraw: React.ComponentType<unknown>;
  readonly exportToBlob: (opts: unknown) => Promise<Blob>;
  readonly exportToSvg: (opts: unknown) => Promise<SVGSVGElement>;
}

// Memoised handle to the dynamic import. React.lazy memoises the
// component factory; we additionally cache the export helpers (which
// are NOT React components and therefore not eligible for lazy()) on
// the same module promise.
let excalidrawModulePromise: Promise<ExcalidrawModuleShape> | null = null;
function loadExcalidrawModule(): Promise<ExcalidrawModuleShape> {
  if (excalidrawModulePromise === null) {
    excalidrawModulePromise = import('@excalidraw/excalidraw').then((m) => ({
      Excalidraw: m.Excalidraw as unknown as React.ComponentType<unknown>,
      exportToBlob: m.exportToBlob as unknown as (opts: unknown) => Promise<Blob>,
      exportToSvg: m.exportToSvg as unknown as (opts: unknown) => Promise<SVGSVGElement>,
    }));
  }
  return excalidrawModulePromise;
}

const LazyExcalidraw = lazy(async () => {
  const m = await loadExcalidrawModule();
  return { default: m.Excalidraw };
});

const SAVE_DEBOUNCE_MS = 2000;

interface ExcalidrawCanvasProps {
  readonly initialPayload: WhiteboardPayload;
  readonly langCode: string;
  readonly onSceneChange: (payload: WhiteboardPayload) => void;
}

/**
 * Lightweight wrapper around the lazy-loaded Excalidraw component.
 * Keeps the prop massaging (langCode, UIOptions disabling
 * library/export, onChange → WhiteboardPayload mapping) in one place
 * so the page body stays readable.
 */
function ExcalidrawCanvas({
  initialPayload,
  langCode,
  onSceneChange,
}: ExcalidrawCanvasProps): JSX.Element {
  // Memo the initial data so React.lazy + Excalidraw don't see a
  // referentially-new value on every render (Excalidraw warns and
  // re-mounts the scene if `initialData` keeps changing identity).
  const initialData = useMemo(
    () => ({
      elements: initialPayload.scene.elements as unknown as readonly unknown[],
      appState: initialPayload.scene.appState as unknown,
      files: initialPayload.files as unknown,
    }),
    [initialPayload],
  );

  const uiOptions = useMemo(
    () => ({
      canvasActions: {
        // Disable in-canvas affordances that would let the user
        // import unsigned scenes / libraries OR overwrite files on
        // disk. The wrapper supplies its own Export menu.
        loadScene: false,
        saveAsImage: false,
        saveToActiveFile: false,
        export: false as const,
      },
    }),
    [],
  );

  return (
    <LazyExcalidraw
      {...({
        initialData,
        langCode,
        UIOptions: uiOptions,
        libraryReturnUrl: undefined,
        onChange: (
          elements: readonly ExcalidrawElement[],
          appState: unknown,
          files: Readonly<Record<string, ExcalidrawFileEntry>>,
        ) => {
          onSceneChange({
            scene: {
              elements: [...elements],
              ...(appState === undefined ? {} : { appState }),
            },
            files: { ...files },
          });
        },
      } as unknown as Record<string, unknown>)}
    />
  );
}

/**
 * Compute a SHA-256 hex digest over a `Uint8Array`. Used as the
 * thumbnail etag the server stores alongside the blob — gives the
 * widget + list page a stable cache key for the rendered PNG.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `crypto.subtle.digest` requires an `ArrayBuffer` or BufferSource.
  // We deliberately copy out of the Uint8Array to defend against
  // `Uint8Array.buffer` being a SharedArrayBuffer in some embeds.
  const buf = bytes.slice().buffer;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const v of view) hex += v.toString(16).padStart(2, '0');
  return hex;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma < 0 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revocation so the browser actually triggers the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WhiteboardDetailPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const session = useSession();
  const current = useCurrentLayer();
  const params = useParams<{ layerSlug: string; whiteboardSlug: string }>();
  const whiteboardSlug = params.whiteboardSlug ?? '';
  const layerSlug = current.status === 'ready' ? current.layer.slug : null;
  const currentUserId = session.user?.id ?? '';

  const [load, setLoad] = useState<WhiteboardDetailLoad>(() => whiteboardDetailLoadInitial());
  const [titleDraft, setTitleDraft] = useState('');
  const [pendingScene, setPendingScene] = useState<WhiteboardPayload | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const restoreKeys = i18nKeysForKind('whiteboard');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInflightRef = useRef<boolean>(false);
  const loadedSnapshotRef = useRef<{
    readonly updatedAt: string;
    readonly updatedBy: string;
  } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    setLoad(whiteboardDetailLoadInitial());
    try {
      const wb = await getWhiteboard(layerSlug, whiteboardSlug);
      loadedSnapshotRef.current = {
        updatedAt: wb.meta.updatedAt,
        updatedBy: wb.meta.updatedBy,
      };
      setLoad({
        status: 'ready',
        whiteboard: wb,
        errorKey: null,
        locked: false,
        saveErrorKey: null,
        saving: false,
      });
      setTitleDraft(wb.title);
      setPendingScene(null);
      setLastSavedAt(wb.meta.updatedAt);
    } catch (err: unknown) {
      setLoad({
        status: 'error',
        errorKey: errorKeyOf(err),
        whiteboard: null,
        locked: false,
        saveErrorKey: null,
        saving: false,
      });
    }
  }, [layerSlug, whiteboardSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Cleanup the debounce timer on unmount so a saved-but-not-yet-fired
  // timer can't fire after navigation.
  useEffect(() => {
    return (): void => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, []);

  /**
   * Persist a single checkpoint with thumbnail. Renders the PNG via
   * `exportToBlob` immediately before the PATCH so the bytes match the
   * scene the server is about to store.
   */
  const performCheckpoint = useCallback(
    async (payload: WhiteboardPayload, titleOverride?: string): Promise<void> => {
      if (layerSlug === null || load.whiteboard === null) return;
      if (saveInflightRef.current) return;
      saveInflightRef.current = true;
      setLoad((prev) => ({ ...prev, saving: true, saveErrorKey: null }));
      try {
        let thumbnailBlobBase64: string | undefined;
        let thumbnailEtag: string | undefined;
        // Render the thumbnail. If Excalidraw isn't loaded yet (e.g.
        // an immediate manual save before the lazy chunk arrived) we
        // skip the thumbnail; the server happily accepts a checkpoint
        // without one.
        if (payload.scene.elements.length > 0) {
          try {
            const m = await loadExcalidrawModule();
            const blob = await m.exportToBlob({
              mimeType: 'image/png',
              elements: payload.scene.elements as unknown,
              appState: (payload.scene.appState ?? {}) as unknown,
              files: payload.files as unknown,
              exportPadding: 16,
            });
            const b64 = await blobToBase64(blob);
            const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
            thumbnailEtag = await sha256Hex(bytes);
            thumbnailBlobBase64 = b64;
          } catch {
            // Render failure → save the scene without a thumbnail.
            thumbnailBlobBase64 = undefined;
            thumbnailEtag = undefined;
          }
        }

        const result = await patchWhiteboardCheckpoint(layerSlug, whiteboardSlug, {
          payload,
          ...(titleOverride === undefined ? {} : { title: titleOverride }),
          ...(thumbnailBlobBase64 === undefined ? {} : { thumbnailBlobBase64 }),
          ...(thumbnailEtag === undefined ? {} : { thumbnailEtag }),
        });
        loadedSnapshotRef.current = {
          updatedAt: result.entity.meta.updatedAt,
          updatedBy: result.entity.meta.updatedBy,
        };
        setLoad({
          status: 'ready',
          whiteboard: result.entity,
          errorKey: null,
          locked: false,
          saveErrorKey: null,
          saving: false,
        });
        setLastSavedAt(result.lastCheckpointAt);
        setPendingScene(null);
      } catch (err: unknown) {
        setLoad((prev) => ({
          ...prev,
          saving: false,
          saveErrorKey: errorKeyOf(err),
        }));
      } finally {
        saveInflightRef.current = false;
      }
    },
    [layerSlug, whiteboardSlug, load.whiteboard],
  );

  // Debounced auto-save: a 2-second-idle timer schedules a checkpoint
  // whenever the scene changes. Hard saves (manual button + title
  // rename) bypass the timer.
  const handleSceneChange = useCallback(
    (next: WhiteboardPayload): void => {
      setPendingScene(next);
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void performCheckpoint(next);
      }, SAVE_DEBOUNCE_MS);
    },
    [performCheckpoint],
  );

  async function handleManualSave(): Promise<void> {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const payload =
      pendingScene ?? (load.whiteboard?.payload as WhiteboardPayload | undefined) ?? null;
    if (payload === null) return;
    await performCheckpoint(payload);
  }

  async function handleTitleSubmit(ev: FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    if (layerSlug === null || load.whiteboard === null) return;
    const next = titleDraft.trim();
    if (next.length === 0 || next === load.whiteboard.title) return;
    setLoad((prev) => ({ ...prev, saving: true, saveErrorKey: null }));
    try {
      const updated = await patchWhiteboard(layerSlug, whiteboardSlug, {
        title: next,
        payload: load.whiteboard.payload,
      });
      loadedSnapshotRef.current = {
        updatedAt: updated.meta.updatedAt,
        updatedBy: updated.meta.updatedBy,
      };
      setLoad({
        status: 'ready',
        whiteboard: updated,
        errorKey: null,
        locked: false,
        saveErrorKey: null,
        saving: false,
      });
      setLastSavedAt(updated.meta.updatedAt);
    } catch (err: unknown) {
      setLoad((prev) => ({
        ...prev,
        saving: false,
        saveErrorKey: errorKeyOf(err),
      }));
    }
  }

  async function handleExport(format: 'png' | 'svg'): Promise<void> {
    const wb = load.whiteboard;
    if (wb === null) return;
    setExportMenuOpen(false);
    const payload = (pendingScene ?? wb.payload) as WhiteboardPayload;
    try {
      const m = await loadExcalidrawModule();
      const baseFilename = wb.slug.length > 0 ? wb.slug : 'whiteboard';
      if (format === 'png') {
        const blob = await m.exportToBlob({
          mimeType: 'image/png',
          elements: payload.scene.elements as unknown,
          appState: (payload.scene.appState ?? {}) as unknown,
          files: payload.files as unknown,
          exportPadding: 16,
        });
        triggerDownload(blob, `${baseFilename}.png`);
      } else {
        const svg = await m.exportToSvg({
          elements: payload.scene.elements as unknown,
          appState: (payload.scene.appState ?? {}) as unknown,
          files: payload.files as unknown,
          exportPadding: 16,
        });
        // `exportToSvg` returns an `SVGSVGElement`. Serialize it to a
        // blob WITHOUT injecting it into the DOM — direct injection
        // would be the stored-XSS hole the plan §7 Security row warns
        // about.
        const serialized = new XMLSerializer().serializeToString(svg);
        const blob = new Blob([serialized], { type: 'image/svg+xml' });
        triggerDownload(blob, `${baseFilename}.svg`);
      }
    } catch (err: unknown) {
      setLoad((prev) => ({ ...prev, saveErrorKey: errorKeyOf(err) }));
    }
  }

  async function handleDelete(): Promise<void> {
    if (layerSlug === null) return;
    setDeletePending(true);
    try {
      await softDeleteWhiteboard(layerSlug, whiteboardSlug);
      navigate(webWhiteboardsPath(layerSlug));
    } catch (err: unknown) {
      setLoad((prev) => ({ ...prev, saveErrorKey: errorKeyOf(err) }));
      setDeletePending(false);
    }
  }

  async function handleRestore(): Promise<void> {
    if (restorePending || layerSlug === null) return;
    setRestorePending(true);
    setRestoreError(null);
    const startedAt = Date.now();
    const telemetry = restoreTelemetryName('whiteboard');
    try {
      await restoreEntity(layerSlug, 'whiteboard', whiteboardSlug);
      console.log(`[${telemetry}]`, { success: true, latencyMs: Date.now() - startedAt });
      trackEvent('entity_restored', { kind: 'whiteboard', layerSlug });
      pushToast({ kind: 'success', message: t(restoreKeys.restored) });
      setRestoreDialogOpen(false);
      await refresh();
    } catch (err: unknown) {
      console.log(`[${telemetry}]`, { success: false, latencyMs: Date.now() - startedAt });
      setRestoreError(errorKeyOf(err));
    } finally {
      setRestorePending(false);
    }
  }

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  // `layerSlug` is non-null here — `current.status === 'ready'` set
  // it. Re-bind to a non-nullable local so the JSX below can pass it
  // to the URL helpers without a `!` assertion.
  const slug = current.layer.slug;

  const view = whiteboardDetailView(load);

  if (view.kind === 'loading') {
    return (
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {t('entity.whiteboards.detail.loading')}
      </div>
    );
  }
  if (view.kind === 'error') {
    return (
      <div className="space-y-2" role="alert">
        <p className="text-sm text-destructive">{t(view.errorKey)}</p>
        <Button type="button" variant="outline" onClick={() => void refresh()}>
          {t('entity.whiteboards.list.retry')}
        </Button>
      </div>
    );
  }

  const wb = view.whiteboard;
  const showLockBanner =
    loadedSnapshotRef.current !== null &&
    shouldShowLockBanner({
      loadedAt: loadedSnapshotRef.current.updatedAt,
      loadedBy: loadedSnapshotRef.current.updatedBy,
      currentUserId,
      serverUpdatedAt: wb.meta.updatedAt,
      serverUpdatedBy: wb.meta.updatedBy,
    });

  const savedAtRelative =
    lastSavedAt === null
      ? null
      : (formatRelativeTime(lastSavedAt, { locale: i18n.resolvedLanguage ?? 'en' }) ??
        t('entity.whiteboards.detail.savedJustNow'));
  const langCode = i18n.resolvedLanguage ?? 'en';
  const hasUnsaved = pendingScene !== null && !view.saving;

  const showRestoreBanner = isSoftDeleted(wb.meta) && current.canEdit;

  return (
    <section className="space-y-3">
      {showRestoreBanner ? (
        <RestoreBanner
          titleKey={restoreKeys.bannerTitle}
          bodyKey={restoreKeys.bannerBody}
          restoreCtaKey={restoreKeys.restoreCta}
          confirmTitleKey={restoreKeys.confirmTitle}
          confirmBodyKey={restoreKeys.confirmBody}
          cancelKey={restoreKeys.cancel}
          busy={restorePending}
          errorKey={restoreError}
          dialogOpen={restoreDialogOpen}
          onDialogOpenChange={setRestoreDialogOpen}
          onConfirm={() => void handleRestore()}
        />
      ) : null}
      <header className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" onClick={() => navigate(webWhiteboardsPath(slug))}>
          {t('entity.whiteboards.detail.back')}
        </Button>
        <form
          onSubmit={(ev) => void handleTitleSubmit(ev)}
          className="flex flex-1 items-center gap-2"
        >
          <Label htmlFor="whiteboard-title" className="sr-only">
            {t('entity.whiteboards.detail.title')}
          </Label>
          <Input
            id="whiteboard-title"
            value={titleDraft}
            onChange={(ev) => setTitleDraft(ev.target.value)}
            className="max-w-md"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={view.saving || titleDraft.trim() === wb.title}
          >
            {t('entity.whiteboards.detail.rename')}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {hasUnsaved
            ? t('entity.whiteboards.detail.unsaved')
            : view.saving
              ? t('entity.whiteboards.detail.saving')
              : savedAtRelative !== null
                ? t('entity.whiteboards.detail.savedAt', { when: savedAtRelative })
                : ''}
        </p>
      </header>

      {showLockBanner ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-warning bg-warning/10 px-3 py-2 text-sm"
        >
          <p>{t('entity.whiteboards.detail.lock.banner')}</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
            {t('entity.whiteboards.detail.lock.reload')}
          </Button>
        </div>
      ) : null}

      {view.saveErrorKey !== null ? (
        <div
          role="alert"
          className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm"
        >
          <p className="text-destructive">{t(view.saveErrorKey)}</p>
        </div>
      ) : null}

      <div
        // The canvas is wrapped in a height-bounded box so the parent
        // layout doesn't run into the unbounded-height trap the
        // upstream component triggers on a flex parent.
        className="relative h-[60vh] w-full overflow-hidden rounded-md border bg-card"
        tabIndex={-1}
      >
        <Suspense
          fallback={
            <div
              role="status"
              aria-live="polite"
              className="flex h-full items-center justify-center text-sm text-muted-foreground"
            >
              {t('entity.whiteboards.detail.canvasLoading')}
            </div>
          }
        >
          <ExcalidrawCanvas
            initialPayload={wb.payload}
            langCode={langCode}
            onSceneChange={handleSceneChange}
          />
        </Suspense>
      </div>

      <footer className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => void handleManualSave()}
          disabled={view.saving || pendingScene === null}
        >
          {t('entity.whiteboards.detail.saveVersion')}
        </Button>

        <div className="relative">
          <Button
            type="button"
            variant="outline"
            onClick={() => setExportMenuOpen((v) => !v)}
            aria-expanded={exportMenuOpen}
            aria-haspopup="menu"
          >
            {t('entity.whiteboards.detail.export.menu')}
          </Button>
          {exportMenuOpen ? (
            <ul
              role="menu"
              className="absolute z-10 mt-1 w-48 rounded-md border bg-popover p-1 shadow-md"
              onKeyDown={(ev) => {
                if (ev.key === 'Escape') {
                  ev.preventDefault();
                  setExportMenuOpen(false);
                }
              }}
            >
              <li role="none">
                <Button
                  type="button"
                  variant="ghost"
                  role="menuitem"
                  className="w-full justify-start"
                  onClick={() => void handleExport('png')}
                >
                  {t('entity.whiteboards.detail.export.png')}
                </Button>
              </li>
              <li role="none">
                <Button
                  type="button"
                  variant="ghost"
                  role="menuitem"
                  className="w-full justify-start"
                  onClick={() => void handleExport('svg')}
                >
                  {t('entity.whiteboards.detail.export.svg')}
                </Button>
              </li>
            </ul>
          ) : null}
        </div>

        <Button
          type="button"
          variant="destructive"
          onClick={() => setDeleteOpen(true)}
          disabled={view.saving}
        >
          {t('entity.whiteboards.detail.delete')}
        </Button>
      </footer>

      <ConfirmDialog
        open={deleteOpen}
        title={t('entity.whiteboards.detail.deleteConfirmTitle')}
        body={t('entity.whiteboards.detail.deleteConfirmBody')}
        confirmLabel={t('entity.whiteboards.detail.deleteCta')}
        cancelLabel={t('entity.whiteboards.detail.deleteCancel')}
        destructive
        onConfirm={() => void handleDelete()}
        onClose={() => setDeleteOpen(false)}
        busy={deletePending}
      />
    </section>
  );
}
