import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { importContactsVcard, type ContactsImportVcardResult } from '../lib/api';
import { errorKeyOf } from '../lib/errors';

/**
 * Phase 4b.2 — minimal vCard import UI at
 * `/l/:layerSlug/contacts/import`. Pure form: file input restricted to
 * `.vcf`, submit, result panel. Errors and warnings come back from the
 * server as i18n keys. The page stays accessible — semantic label,
 * `aria-live` on the result region, `role="alert"` on errors.
 *
 * 4b.5 will surface this page from the contacts list once the list page
 * lands; for now the route is reachable directly.
 */

type LoadState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; result: ContactsImportVcardResult }
  | { kind: 'error'; errorKey: string };

export function ContactsImportPage(): JSX.Element {
  const { t } = useTranslation();
  const { layerSlug } = useParams<{ layerSlug: string }>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });

  async function onSubmit(ev: FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    if (layerSlug === undefined) return;
    const file = fileInputRef.current?.files?.[0];
    if (file === undefined) {
      setState({ kind: 'error', errorKey: 'connectors.vcard.importNoFile' });
      return;
    }
    setState({ kind: 'submitting' });
    try {
      const result = await importContactsVcard(layerSlug, file);
      setState({ kind: 'success', result });
    } catch (err: unknown) {
      setState({ kind: 'error', errorKey: errorKeyOf(err) });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('connectors.vcard.importTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={(ev) => void onSubmit(ev)}>
          <p className="text-sm text-muted-foreground">{t('connectors.vcard.description')}</p>
          <div className="space-y-2">
            <Label htmlFor="vcard-file">{t('connectors.vcard.importChooseFile')}</Label>
            <Input
              id="vcard-file"
              ref={fileInputRef}
              type="file"
              accept=".vcf,text/vcard,text/x-vcard"
              required
            />
          </div>
          <Button type="submit" disabled={state.kind === 'submitting'}>
            {state.kind === 'submitting'
              ? t('connectors.vcard.importSubmitting')
              : t('connectors.vcard.importSubmit')}
          </Button>
        </form>
        {state.kind === 'success' ? (
          <div role="status" aria-live="polite" className="mt-4 space-y-2">
            <p className="text-sm">
              {t('connectors.vcard.importSuccess', {
                created: state.result.created,
                updated: state.result.updated,
              })}
            </p>
            {state.result.warnings.length > 0 ? (
              <div>
                <h3 className="text-sm font-semibold">
                  {t('connectors.vcard.importWarningsTitle')}
                </h3>
                <ul className="ml-5 list-disc text-sm text-muted-foreground">
                  {state.result.warnings.map((w, i) => (
                    <li key={`${w}-${i}`}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
        {state.kind === 'error' ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {t(state.errorKey, { defaultValue: t('errors.network') })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
