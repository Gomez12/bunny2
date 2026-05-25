import { useTranslation } from 'react-i18next';
import type { ContactFormDraft } from '../../pages/contacts-page-state';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

/**
 * Shared email-array editor. Lifted from `ContactDetailPage.tsx` in the
 * `contacts-manual-create` follow-up so both the detail page and the
 * create dialog render the same control. Behaviour is unchanged from the
 * detail-page-local version — the input ids accept an `idPrefix` so the
 * same editor can mount twice on the same page without colliding labels.
 */
export interface EmailListEditorProps {
  readonly drafts: ContactFormDraft['emails'];
  readonly disabled: boolean;
  readonly idPrefix?: string;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
  readonly onUpdate: (index: number, patch: Partial<ContactFormDraft['emails'][number]>) => void;
  readonly onPromote: (index: number) => void;
}

export function EmailListEditor(props: EmailListEditorProps): JSX.Element {
  const { t } = useTranslation();
  const prefix = props.idPrefix ?? 'c';
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t('entity.contacts.fieldEmails')}</legend>
      {props.drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('entity.contacts.emailsEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {props.drafts.map((e, i) => (
            <li key={`email-${i}`} className="grid grid-cols-1 gap-2 md:grid-cols-6">
              <div className="space-y-1 md:col-span-3">
                <Label htmlFor={`${prefix}-email-value-${i}`}>
                  {t('entity.contacts.fieldEmailValue')}
                </Label>
                <Input
                  id={`${prefix}-email-value-${i}`}
                  type="email"
                  value={e.value}
                  onChange={(ev) => props.onUpdate(i, { value: ev.target.value })}
                  disabled={props.disabled}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor={`${prefix}-email-label-${i}`}>
                  {t('entity.contacts.fieldEmailLabel')}
                </Label>
                <Input
                  id={`${prefix}-email-label-${i}`}
                  value={e.label}
                  onChange={(ev) => props.onUpdate(i, { label: ev.target.value })}
                  disabled={props.disabled}
                  autoComplete="off"
                />
              </div>
              <div className="flex items-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={e.isPrimary ? 'default' : 'ghost'}
                  onClick={() => props.onPromote(i)}
                  disabled={props.disabled}
                  aria-pressed={e.isPrimary}
                  title={t('entity.contacts.fieldEmailPrimary')}
                >
                  {t('entity.contacts.fieldEmailPrimary')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => props.onRemove(i)}
                  disabled={props.disabled}
                  aria-label={t('entity.contacts.fieldEmailRemove')}
                >
                  {t('entity.contacts.fieldEmailRemove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={props.onAdd}
        disabled={props.disabled}
      >
        {t('entity.contacts.fieldEmailAdd')}
      </Button>
    </fieldset>
  );
}
