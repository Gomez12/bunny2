import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import { logout } from '../lib/api';
import { applyLogout, useSession } from '../lib/session';

/**
 * Account chip in the AppShell header.
 *
 * Hand-rolled menu (no Radix) — the surface area is small: a button
 * trigger, a `role="menu"` panel with two `role="menuitem"` buttons,
 * ESC closes, click-away closes, focus returns to the trigger on close.
 *
 * The change-password action does not navigate; it raises a callback
 * that the AppShell uses to switch the active "tab" to the non-forced
 * change-password view.
 */
export interface UserMenuProps {
  readonly onChangePassword: () => void;
}

export function UserMenu(props: UserMenuProps): JSX.Element | null {
  const { t } = useTranslation();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [pendingLogout, setPendingLogout] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent): void {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (
        menuRef.current !== null &&
        !menuRef.current.contains(target) &&
        triggerRef.current !== null &&
        !triggerRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return (): void => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function closeAndRestore(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAndRestore();
    }
  }

  async function handleSignOut(): Promise<void> {
    if (pendingLogout) return;
    setPendingLogout(true);
    try {
      await logout();
    } catch {
      // Even if the network call fails, clear local state. The cookie
      // may still be valid on the server, but UX-wise the user wants
      // out.
    } finally {
      applyLogout();
      setPendingLogout(false);
    }
  }

  if (session.status !== 'authenticated' || session.user === null) return null;
  const displayName = session.user.displayName;

  return (
    <div className="relative">
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('auth.userMenu.signedInAs', { name: displayName })}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{displayName}</span>
        <span aria-hidden="true">{'▾'}</span>
      </Button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('auth.userMenu.signedInAs', { name: displayName })}
          onKeyDown={handleKeyDown}
          className="absolute right-0 z-50 mt-2 min-w-[12rem] rounded-md border bg-card p-1 text-card-foreground shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setOpen(false);
              props.onChangePassword();
            }}
          >
            {t('auth.userMenu.changePassword')}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={pendingLogout}
            className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void handleSignOut()}
          >
            {t('auth.userMenu.signOut')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
