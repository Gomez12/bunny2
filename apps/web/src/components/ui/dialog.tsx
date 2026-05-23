import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { Button } from './button';

/**
 * Native `<dialog>`-based modal.
 *
 * Phase 2.6 picks the platform element rather than pulling in a Radix
 * dialog dependency. The browser handles focus trap, ESC dismissal,
 * `::backdrop`, and inert-on-the-rest-of-the-document for free. We add:
 *
 *  - Click-on-backdrop closes (compare `e.target === dialogRef.current`).
 *  - Title via `aria-labelledby`, description via `aria-describedby`.
 *  - A close button in the header so the dialog is operable without a
 *    keyboard.
 *
 * Open / close is driven by an `open` prop the parent owns; we sync to
 * the dialog imperatively in an effect so we never leave the element
 * out of sync.
 */
export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
  readonly footer?: React.ReactNode;
  readonly closeLabel: string;
}

let dialogId = 0;
function nextDialogId(): string {
  dialogId += 1;
  return `bunny2-dialog-${String(dialogId)}`;
}

export function Dialog(props: DialogProps): JSX.Element {
  const { open, onClose, title, description, children, footer, closeLabel } = props;
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);
  const idRef = React.useRef<string>(nextDialogId());
  const titleId = `${idRef.current}-title`;
  const descId = description !== undefined ? `${idRef.current}-desc` : undefined;

  React.useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg === null) return;
    if (open && !dlg.open) {
      dlg.showModal();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  function handleBackdropMouseDown(e: React.MouseEvent<HTMLDialogElement>): void {
    if (e.target === dialogRef.current) {
      onClose();
    }
  }

  function handleCancel(e: React.SyntheticEvent<HTMLDialogElement>): void {
    // ESC pressed; intercept so React state stays in sync.
    e.preventDefault();
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="w-full max-w-lg rounded-lg border bg-card p-0 text-card-foreground shadow-lg backdrop:bg-black/40"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={handleCancel}
      onMouseDown={handleBackdropMouseDown}
    >
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 id={titleId} className="text-lg font-semibold leading-none tracking-tight">
              {title}
            </h2>
            {description !== undefined ? (
              <p id={descId} className="text-sm text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          <Button type="button" variant="ghost" size="sm" aria-label={closeLabel} onClick={onClose}>
            {'×'}
          </Button>
        </div>
        <div>{children}</div>
        {footer !== undefined ? <div className="flex justify-end gap-2">{footer}</div> : null}
      </div>
    </dialog>
  );
}

/**
 * Convenience confirm dialog. Body is plain text; for richer content pass
 * a custom `<Dialog>`.
 */
export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly busy?: boolean;
  readonly errorKey?: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
  const { t } = useTranslation();
  const {
    open,
    title,
    body,
    confirmLabel,
    cancelLabel,
    destructive,
    busy,
    errorKey,
    onConfirm,
    onClose,
  } = props;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy === true}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant={destructive === true ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={busy === true}
          >
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      <p className={cn('text-sm', destructive === true ? 'text-destructive' : undefined)}>{body}</p>
      {errorKey !== undefined && errorKey !== null ? (
        <p role="alert" aria-live="polite" className="mt-3 text-sm text-destructive">
          {t(errorKey, { defaultValue: t('errors.network') })}
        </p>
      ) : null}
    </Dialog>
  );
}
