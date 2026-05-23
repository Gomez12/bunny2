import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { login } from '../lib/api';
import { errorKeyOf } from '../lib/errors';
import { applyLogin } from '../lib/session';

/**
 * Login page.
 *
 * Single form with labelled inputs (autocomplete `username` +
 * `current-password`). Error region uses `role="alert"` + `aria-live`
 * and is linked from each input via `aria-describedby` so screen readers
 * announce the failure when the user blurs.
 *
 * Focus management:
 *   - On mount the username input receives focus.
 *   - On error the error region receives focus so the localized message
 *     is read aloud immediately.
 */
export function LoginPage(): JSX.Element {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  useEffect(() => {
    if (errorKey !== null) {
      errorRef.current?.focus();
    }
  }, [errorKey]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setErrorKey(null);
    setPending(true);
    try {
      const response = await login({ username, password });
      applyLogin(response);
    } catch (err: unknown) {
      setErrorKey(errorKeyOf(err));
    } finally {
      setPending(false);
    }
  }

  const describedBy = errorKey !== null ? 'login-error' : undefined;

  return (
    <div className="mx-auto flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('auth.login.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="login-username">{t('auth.login.usernameLabel')}</Label>
              <Input
                id="login-username"
                ref={usernameRef}
                type="text"
                name="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={pending}
                required
                aria-describedby={describedBy}
                aria-invalid={errorKey !== null ? true : undefined}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="login-password">{t('auth.login.passwordLabel')}</Label>
              <Input
                id="login-password"
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={pending}
                required
                aria-describedby={describedBy}
                aria-invalid={errorKey !== null ? true : undefined}
              />
            </div>
            {errorKey !== null ? (
              <div
                id="login-error"
                ref={errorRef}
                role="alert"
                aria-live="polite"
                tabIndex={-1}
                className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
              >
                <p className="font-medium">{t('auth.login.errorTitle')}</p>
                <p>
                  <span className="font-semibold">{t('auth.login.errorPrefix')}</span>{' '}
                  {t(errorKey, { defaultValue: t('errors.network') })}
                </p>
              </div>
            ) : null}
            <div>
              <Button type="submit" disabled={pending} className="w-full">
                {pending ? t('auth.login.submitting') : t('auth.login.submit')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
