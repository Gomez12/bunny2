import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../ui/button';

/**
 * Admin navigation dropdown shown in the AppShell header for admins.
 *
 * Phase 1 of `docs/dev/plans/admin-observability-viewer.md` — once the
 * admin surface grew past four buttons (Users, Groups, Scheduled tasks,
 * Bus DLQ) the header was crowded; phases 2–6 add ~4 more. Collapse
 * everything under a single "Admin" trigger so the visible header stays
 * uncluttered while every admin entry remains reachable.
 *
 * Hand-rolled menu, matching the project's existing pattern in
 * `LayerSwitcher` and `UserMenu` — no Radix dependency. Plan §3
 * mentioned shadcn `DropdownMenu`, but the codebase has no Radix yet
 * and the hand-rolled `role="menu"` pattern already meets the
 * accessibility bar (Arrow/Home/End/ESC/Enter/Space, click-away,
 * focus restore).
 *
 * Sections shown in Phase 1:
 *   - Users & Groups: Users, Groups
 *   - Operations: Scheduled tasks, Bus DLQ
 *
 * The "Observability" section is intentionally **not** added here in
 * Phase 1 — its pages land incrementally in Phases 2–6 of the plan,
 * and each phase wires its own menu item then. Stubbing dead links
 * now would mislead admins.
 */

interface AdminNavItem {
  readonly key: string;
  readonly labelKey: string;
  readonly path: string;
}

interface AdminNavSection {
  readonly key: string;
  readonly headingKey: string;
  readonly items: readonly AdminNavItem[];
}

const SECTIONS: readonly AdminNavSection[] = [
  {
    key: 'usersAndGroups',
    headingKey: 'admin.nav.sections.usersAndGroups',
    items: [
      { key: 'users', labelKey: 'admin.nav.users', path: '/admin/users' },
      { key: 'groups', labelKey: 'admin.nav.groups', path: '/admin/groups' },
    ],
  },
  {
    key: 'operations',
    headingKey: 'admin.nav.sections.operations',
    items: [
      {
        key: 'scheduledTasks',
        labelKey: 'admin.nav.scheduledTasks',
        path: '/admin/scheduled-tasks',
      },
      { key: 'busDlq', labelKey: 'admin.nav.busDlq', path: '/admin/bus/dlq' },
    ],
  },
];

const FLAT_ITEMS: readonly AdminNavItem[] = SECTIONS.flatMap((s) => s.items);

export function AdminNav(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState<number>(-1);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const isAdminRoute = location.pathname.startsWith('/admin/');
  const currentItemKey = useMemo<string | null>(() => {
    const match = FLAT_ITEMS.find(
      (it) => location.pathname === it.path || location.pathname.startsWith(it.path + '/'),
    );
    return match?.key ?? null;
  }, [location.pathname]);

  const close = useCallback((restoreFocus = true): void => {
    setOpen(false);
    setFocusIndex(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Click-away closes the menu without restoring focus (the user
  // clicked elsewhere on purpose).
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

  // Move DOM focus to the highlighted menu item when the active index
  // changes — same pattern as `LayerSwitcher`.
  useEffect(() => {
    if (!open) return;
    if (focusIndex < 0) return;
    itemRefs.current[focusIndex]?.focus();
  }, [open, focusIndex]);

  function selectItem(item: AdminNavItem): void {
    close(false);
    navigate(item.path);
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
      setFocusIndex((i) => (i + 1) % Math.max(FLAT_ITEMS.length, 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((i) => (i - 1 + FLAT_ITEMS.length) % Math.max(FLAT_ITEMS.length, 1));
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      setFocusIndex(0);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      setFocusIndex(FLAT_ITEMS.length - 1);
      return;
    }
  }

  // Reset the per-render ref array so we always have one slot per
  // visible menu item.
  itemRefs.current = [];

  return (
    <div className="relative">
      <Button
        ref={triggerRef}
        type="button"
        variant={isAdminRoute ? 'default' : 'ghost'}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={isAdminRoute ? 'page' : undefined}
        aria-label={t('admin.nav.label')}
        onClick={() => {
          setOpen((v) => !v);
          setFocusIndex(0);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="flex items-center gap-2">
          <span>{t('admin.nav.label')}</span>
          <span aria-hidden="true">{'▾'}</span>
        </span>
      </Button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('admin.nav.label')}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-50 mt-2 min-w-[14rem] rounded-md border bg-card p-1 text-card-foreground shadow-md"
        >
          {SECTIONS.map((section) => (
            <div
              key={section.key}
              role="group"
              aria-labelledby={`admin-nav-section-${section.key}`}
            >
              <div
                id={`admin-nav-section-${section.key}`}
                className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {t(section.headingKey)}
              </div>
              {section.items.map((item) => {
                const indexInFlat = FLAT_ITEMS.indexOf(item);
                const isCurrent = currentItemKey === item.key;
                return (
                  <button
                    key={item.key}
                    ref={(el) => {
                      itemRefs.current[indexInFlat] = el;
                    }}
                    type="button"
                    role="menuitem"
                    aria-current={isCurrent ? 'page' : undefined}
                    tabIndex={focusIndex === indexInFlat ? 0 : -1}
                    className={
                      'flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring' +
                      (isCurrent ? ' bg-muted/70 font-medium' : '')
                    }
                    onClick={() => selectItem(item)}
                    onFocus={() => setFocusIndex(indexInFlat)}
                  >
                    <span className="truncate">{t(item.labelKey)}</span>
                    {isCurrent ? (
                      <span aria-hidden="true" className="text-xs text-muted-foreground">
                        {'•'}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
