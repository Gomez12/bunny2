import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './button';
import { ConfirmDialog } from './dialog';

/**
 * Phase 1 — UI exposure gaps: soft-delete restore banner.
 *
 * Rendered at the top of an entity detail page when the row has a
 * non-null `deletedAt`. Shows a per-kind localized message and a
 * destructive-style Restore button. Clicking opens a confirm dialog
 * that delegates to the native `<dialog>` element's focus trap + ESC
 * dismissal (see `components/ui/dialog.tsx`). Focus returns to the
 * Restore trigger when the dialog closes — implemented manually here
 * because the native `<dialog>` re-focuses the previously-active
 * element on close only when `showModal()` was called from that
 * element; we restore focus defensively after our async confirm path.
 *
 * Permission gate: callers pass `canEdit={current.canEdit}` so the
 * banner stays hidden for actors that cannot mutate the entity. The
 * server is still the source of truth (`POST .../restore` enforces
 * the same permission as `DELETE`); the gate is a UI affordance only.
 *
 * Telemetry / analytics: the caller wires `onConfirm` to call
 * `restoreEntity(...)` + emit `entity_restored` analytics +
 * `[entity.<kind>.restore]` console log. The banner itself is pure
 * presentation; it carries no business logic.
 */
export interface RestoreBannerProps {
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly restoreCtaKey: string;
  readonly confirmTitleKey: string;
  readonly confirmBodyKey: string;
  readonly cancelKey: string;
  readonly busy: boolean;
  readonly errorKey: string | null;
  /**
   * Called when the user clicks Confirm in the dialog. The caller
   * should perform the async restore and either re-render with the
   * banner gone (success) or surface the error via `errorKey`. To
   * dismiss the dialog from the success path the caller passes a
   * `dialogOpen={false}` controlled signal — see below.
   */
  readonly onConfirm: () => void;
  /**
   * Controlled signal from the caller: when `true`, the dialog opens
   * on next render. We expose this so the caller can force the dialog
   * shut from its success path (where the banner itself is about to
   * unmount) without leaving the native `<dialog>` element open.
   */
  readonly dialogOpen?: boolean;
  readonly onDialogOpenChange?: (next: boolean) => void;
}

export function RestoreBanner(props: RestoreBannerProps): JSX.Element {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = props.dialogOpen ?? internalOpen;
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  function setOpen(next: boolean): void {
    if (props.onDialogOpenChange !== undefined) {
      props.onDialogOpenChange(next);
    } else {
      setInternalOpen(next);
    }
  }

  function handleClose(): void {
    setOpen(false);
    // Defer focus restoration so the dialog finishes closing first.
    // Without the timeout the focus call fires before the native
    // `<dialog>` element has yielded its trap and the trigger never
    // regains focus.
    setTimeout(() => {
      triggerRef.current?.focus();
    }, 0);
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm"
    >
      <div className="flex flex-col gap-1">
        <p className="font-medium text-destructive">{t(props.titleKey)}</p>
        <p className="text-destructive/90">{t(props.bodyKey)}</p>
      </div>
      <Button
        ref={triggerRef}
        type="button"
        variant="destructive"
        onClick={() => setOpen(true)}
        disabled={props.busy}
        data-restore-banner-cta
      >
        {t(props.restoreCtaKey)}
      </Button>
      <ConfirmDialog
        open={open}
        title={t(props.confirmTitleKey)}
        body={t(props.confirmBodyKey)}
        confirmLabel={t(props.restoreCtaKey)}
        cancelLabel={t(props.cancelKey)}
        destructive
        busy={props.busy}
        errorKey={props.errorKey}
        onConfirm={props.onConfirm}
        onClose={handleClose}
      />
    </div>
  );
}
