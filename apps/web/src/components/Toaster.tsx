import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import { cn } from '../lib/cn';
import { dismissToast, useToasts, type ToastKind } from '../lib/toast';

/**
 * Live region for the `pushToast()` queue.
 *
 * Mounted once in `App.tsx`. Uses `aria-live="polite"` so additions
 * are announced to screen readers without interrupting the current
 * speech. Each toast can be dismissed manually with the close button;
 * `pushToast` auto-dismisses after the configured `ttlMs`.
 */

const KIND_STYLES: Record<ToastKind, string> = {
  info: 'border-border bg-card text-card-foreground',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-foreground',
  error: 'border-destructive/40 bg-destructive/10 text-foreground',
};

export function Toaster(): JSX.Element {
  const { t } = useTranslation();
  const toasts = useToasts();

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm shadow-md',
            KIND_STYLES[toast.kind],
          )}
        >
          <p className="flex-1 leading-snug">{toast.message}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('common.close')}
            onClick={() => dismissToast(toast.id)}
          >
            {'×'}
          </Button>
        </div>
      ))}
    </div>
  );
}
