import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { changePassword } from '../lib/api';
import { errorKeyOf } from '../lib/errors';
import { bootstrapSession } from '../lib/session';

/**
 * Mirrors the server policy from
 * `apps/server/src/auth/password.ts::validateNewPassword`: at least 12
 * characters with at least one non-letter. We surface the same i18n key
 * (`errors.auth.weakPassword`) so the localized message matches whatever
 * the server would return — but the server still validates as the source
 * of truth.
 */
function clientWeakPassword(password: string): boolean {
  if (password.length < 12) return true;
  return !/[^A-Za-z]/.test(password);
}

export interface ChangePasswordPageProps {
  readonly forced?: boolean;
  /**
   * Optional callback fired on success. Used by the non-forced (account
   * menu) variant so the AppShell can route the user back to a normal
   * page. The forced variant ignores this — the bootstrap re-runs and
   * the AppShell re-renders via the session state machine.
   */
  readonly onSuccess?: () => void;
}

export function ChangePasswordPage(props: ChangePasswordPageProps): JSX.Element {
  const { t } = useTranslation();
  const forced = props.forced === true;
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [success, setSuccess] = useState(false);
  const errorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (errorKey !== null) {
      errorRef.current?.focus();
    }
  }, [errorKey]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setErrorKey(null);
    setSuccess(false);
    if (newPassword !== confirmPassword) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    if (clientWeakPassword(newPassword)) {
      setErrorKey('errors.auth.weakPassword');
      return;
    }
    setPending(true);
    try {
      const payload: { currentPassword?: string; newPassword: string } = { newPassword };
      if (!forced) payload.currentPassword = currentPassword;
      await changePassword(payload);
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      // Refresh the session so the AppShell can route away from the
      // forced screen. The server has revoked all OTHER sessions but
      // kept this one alive.
      await bootstrapSession();
      props.onSuccess?.();
    } catch (err: unknown) {
      setErrorKey(errorKeyOf(err));
    } finally {
      setPending(false);
    }
  }

  const describedBy = errorKey !== null ? 'cp-error' : undefined;

  return (
    <div className="mx-auto flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('auth.changePassword.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {forced ? (
            <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              {t('auth.changePassword.forcedNotice')}
            </p>
          ) : null}
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
            {!forced ? (
              <div className="space-y-2">
                <Label htmlFor="cp-current">{t('auth.changePassword.currentPasswordLabel')}</Label>
                <Input
                  id="cp-current"
                  type="password"
                  name="currentPassword"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  disabled={pending}
                  required
                  aria-describedby={describedBy}
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="cp-new">{t('auth.changePassword.newPasswordLabel')}</Label>
              <Input
                id="cp-new"
                type="password"
                name="newPassword"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={pending}
                required
                aria-describedby={`cp-policy${describedBy !== undefined ? ' ' + describedBy : ''}`}
              />
              <p id="cp-policy" className="text-xs text-muted-foreground">
                {t('auth.changePassword.policyHint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cp-confirm">{t('auth.changePassword.confirmPasswordLabel')}</Label>
              <Input
                id="cp-confirm"
                type="password"
                name="confirmPassword"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={pending}
                required
                aria-invalid={mismatch ? true : undefined}
                aria-describedby={mismatch ? 'cp-mismatch' : undefined}
              />
              {mismatch ? (
                <p id="cp-mismatch" role="alert" className="text-sm text-destructive">
                  {t('auth.changePassword.mismatch')}
                </p>
              ) : null}
            </div>
            {errorKey !== null ? (
              <div
                id="cp-error"
                ref={errorRef}
                role="alert"
                aria-live="polite"
                tabIndex={-1}
                className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
              >
                {t(errorKey, { defaultValue: t('errors.network') })}
              </div>
            ) : null}
            {success ? (
              <p role="status" aria-live="polite" className="text-sm text-green-700">
                {t('auth.changePassword.success')}
              </p>
            ) : null}
            <div>
              <Button type="submit" disabled={pending} className="w-full">
                {pending ? t('auth.changePassword.submitting') : t('auth.changePassword.submit')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
