import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Button } from './ui/button';
import { LayerTypeBadge } from './LayerTypeBadge';
import { useSession } from '../lib/session';
import type { Layer, LayerType } from '../lib/api-types';
import { subpathFromLocation } from '../lib/use-current-layer';

/**
 * Dropdown next to `UserMenu` that switches the URL-scoped layer.
 *
 * Hand-rolled (no Radix / shadcn DropdownMenu) — the project's pattern
 * is the same as `UserMenu`: native `<button>` trigger, a `role="menu"`
 * panel, ESC + click-away close, focus restored on close. The arrow
 * keys move focus between menu items and ENTER selects.
 *
 * Selecting a layer calls
 * `navigate('/l/<newSlug>' + currentSubpath)` so the user lands on the
 * same logical page in the new layer.
 */

const TYPE_ORDER: readonly LayerType[] = ['personal', 'project', 'group', 'everyone'];

function groupByType(layers: readonly Layer[]): Map<LayerType, Layer[]> {
  const map = new Map<LayerType, Layer[]>();
  for (const t of TYPE_ORDER) map.set(t, []);
  for (const l of layers) {
    map.get(l.type)?.push(l);
  }
  for (const t of TYPE_ORDER) {
    map.get(t)?.sort((a, b) => a.name.localeCompare(b.name));
  }
  return map;
}

export function LayerSwitcher(): JSX.Element | null {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ layerSlug: string }>();
  const currentSlug = params.layerSlug ?? null;

  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState<number>(-1);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const grouped = useMemo(() => groupByType(session.layers), [session.layers]);
  const flatItems = useMemo<Layer[]>(() => {
    const arr: Layer[] = [];
    for (const ty of TYPE_ORDER) {
      const rows = grouped.get(ty);
      if (rows !== undefined) arr.push(...rows);
    }
    return arr;
  }, [grouped]);

  const currentLayer: Layer | null = useMemo(() => {
    if (currentSlug === null) return null;
    return session.layers.find((l) => l.slug === currentSlug) ?? null;
  }, [session.layers, currentSlug]);

  const close = useCallback((restoreFocus = true): void => {
    setOpen(false);
    setFocusIndex(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent): void {
      const tgt = e.target;
      if (!(tgt instanceof Node)) return;
      if (
        menuRef.current !== null &&
        !menuRef.current.contains(tgt) &&
        triggerRef.current !== null &&
        !triggerRef.current.contains(tgt)
      ) {
        close(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return (): void => document.removeEventListener('mousedown', handleClick);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    if (focusIndex < 0) return;
    itemRefs.current[focusIndex]?.focus();
  }, [open, focusIndex]);

  function selectLayer(layer: Layer): void {
    close(false);
    const sub =
      currentSlug !== null ? subpathFromLocation(location.pathname, currentSlug) : '/dashboard';
    navigate(`/l/${layer.slug}${sub}`);
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>): void {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
      setFocusIndex(0);
    }
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex((i) => (i + 1) % Math.max(flatItems.length, 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((i) => (i - 1 + flatItems.length) % Math.max(flatItems.length, 1));
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      setFocusIndex(0);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      setFocusIndex(flatItems.length - 1);
      return;
    }
  }

  if (session.status !== 'authenticated') return null;

  const triggerLabel = currentLayer !== null ? currentLayer.name : t('layer.switcher.currentLabel');

  // Build refs in render so we have a slot per item.
  itemRefs.current = [];

  return (
    <div className="relative">
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('layer.switcher.label')}
        onClick={() => {
          setOpen((v) => !v);
          setFocusIndex(0);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="flex items-center gap-2">
          {currentLayer !== null ? <LayerTypeBadge type={currentLayer.type} /> : null}
          <span>{triggerLabel}</span>
          <span aria-hidden="true">{'▾'}</span>
        </span>
      </Button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('layer.switcher.label')}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-50 mt-2 min-w-[16rem] rounded-md border bg-card p-1 text-card-foreground shadow-md"
        >
          {flatItems.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">{t('layer.switcher.empty')}</p>
          ) : (
            TYPE_ORDER.map((ty) => {
              const rows = grouped.get(ty) ?? [];
              if (rows.length === 0) return null;
              return (
                <div key={ty} role="group" aria-labelledby={`layer-group-${ty}`}>
                  <div
                    id={`layer-group-${ty}`}
                    className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {t(`layer.type.${ty}`)}
                  </div>
                  {rows.map((l) => {
                    const indexInFlat = flatItems.indexOf(l);
                    const isCurrent = l.slug === currentSlug;
                    return (
                      <button
                        key={l.id}
                        ref={(el) => {
                          itemRefs.current[indexInFlat] = el;
                        }}
                        type="button"
                        role="menuitem"
                        aria-current={isCurrent ? 'true' : undefined}
                        tabIndex={focusIndex === indexInFlat ? 0 : -1}
                        className={
                          'flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring' +
                          (isCurrent ? ' bg-muted/70 font-medium' : '')
                        }
                        onClick={() => selectLayer(l)}
                        onFocus={() => setFocusIndex(indexInFlat)}
                      >
                        <span className="truncate">{l.name}</span>
                        {isCurrent ? (
                          <span aria-hidden="true" className="text-xs text-muted-foreground">
                            {'•'}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
