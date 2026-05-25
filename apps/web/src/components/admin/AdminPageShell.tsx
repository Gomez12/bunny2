/**
 * Phase 4 (ui-exposure-gaps) — shared shell for admin pages.
 *
 * Wraps the recurring `<div className="space-y-4"><Card><CardHeader>…
 * <CardContent>…</CardContent></Card></div>` pattern used by
 * `AdminUsersPage`, `AdminGroupsPage`, `AdminScheduledTasksPage`,
 * `AdminBusDlqPage`, and the new `AdminUserDetailPage` /
 * `AdminScheduledTaskRunsPage` introduced in this phase.
 *
 * Intentionally minimal: a card with a header row (title + optional
 * actions slot + optional back link) and a content slot. No
 * breadcrumbs — the app header already provides a current-section
 * label; admin pages stay flat.
 *
 * Keeping the shell in one place means future admin headers
 * (e.g. a global "include deleted" toggle position, action-button
 * spacing) change in one file instead of N.
 */
import type { ReactNode } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

export interface AdminPageShellProps {
  /** Localised page title shown in the card header. */
  readonly title: ReactNode;
  /** Optional right-aligned actions slot (new-row button, refresh, etc.). */
  readonly actions?: ReactNode;
  /**
   * Optional back-link rendered above the card. Used by detail pages
   * (`AdminUserDetailPage`, `AdminScheduledTaskRunsPage`) so the admin
   * can return to the parent list without depending on the browser
   * back stack. Caller supplies the localised label.
   */
  readonly back?: {
    readonly label: string;
    readonly onBack: () => void;
  };
  readonly children: ReactNode;
}

export function AdminPageShell(props: AdminPageShellProps): JSX.Element {
  const { title, actions, back, children } = props;
  return (
    <div className="space-y-4">
      {back !== undefined ? (
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={back.onBack}>
            {back.label}
          </Button>
        </div>
      ) : null}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>{title}</CardTitle>
          {actions !== undefined ? <div className="flex gap-2">{actions}</div> : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}
