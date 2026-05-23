import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Hand-rolled WAI-ARIA tabs.
 *
 * Why no Radix: the project pattern is hand-rolled small primitives
 * (see `dialog.tsx`, `UserMenu.tsx`). One control with a tablist + a
 * single visible panel covers every use in phase 3.5.
 *
 * Keyboard contract follows WAI-ARIA:
 *   - Left / Right arrows move focus between tabs (with wrap-around).
 *   - Home / End jump to the first / last tab.
 *   - Tabs use `tabIndex=0` on the active one, `-1` on the rest
 *     (so Tab moves into the panel, not across the tablist).
 *   - Focusing a tab activates it (automatic activation pattern).
 */

export interface TabDef {
  readonly value: string;
  readonly label: string;
  readonly panel: ReactNode;
}

export interface TabsProps {
  readonly tabs: readonly TabDef[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ariaLabel: string;
  readonly className?: string;
}

export function Tabs(props: TabsProps): JSX.Element {
  const { tabs, value, onChange, ariaLabel, className } = props;
  const baseId = useId();
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tb) => tb.value === value),
  );

  function focusAt(index: number): void {
    const clamped = ((index % tabs.length) + tabs.length) % tabs.length;
    const next = tabs[clamped];
    if (next === undefined) return;
    onChange(next.value);
    buttonRefs.current[clamped]?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusAt(activeIndex + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusAt(activeIndex - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusAt(tabs.length - 1);
    }
  }

  // Defensive: if value isn't in tabs (e.g. URL query references an
  // unknown tab), reset to the first one.
  useEffect(() => {
    if (!tabs.some((tb) => tb.value === value)) {
      const first = tabs[0];
      if (first !== undefined) onChange(first.value);
    }
  }, [tabs, value, onChange]);

  const active = tabs[activeIndex];

  return (
    <div className={cn('space-y-4', className)}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="flex flex-wrap gap-1 border-b"
        onKeyDown={handleKeyDown}
      >
        {tabs.map((tb, i) => {
          const selected = tb.value === value;
          const tabId = `${baseId}-tab-${tb.value}`;
          const panelId = `${baseId}-panel-${tb.value}`;
          return (
            <button
              key={tb.value}
              ref={(el) => {
                buttonRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={tabId}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              className={cn(
                'rounded-t-md border border-b-0 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected
                  ? 'border-border bg-background font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              onClick={() => onChange(tb.value)}
            >
              {tb.label}
            </button>
          );
        })}
      </div>
      {active !== undefined ? (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${active.value}`}
          aria-labelledby={`${baseId}-tab-${active.value}`}
          tabIndex={0}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {active.panel}
        </div>
      ) : null}
    </div>
  );
}
