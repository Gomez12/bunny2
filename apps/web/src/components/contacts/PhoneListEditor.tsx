import { useTranslation } from 'react-i18next';
import type { ContactFormDraft } from '../../pages/contacts-page-state';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

/**
 * Shared phone-array editor. Lifted from `ContactDetailPage.tsx` in the
 * `contacts-manual-create` follow-up so both the detail page and the
 * create dialog render the same control. `idPrefix` keeps input ids
 * unique when the editor is rendered twice on the same page.
 */
export interface PhoneListEditorProps {
  readonly drafts: ContactFormDraft['phones'];
  readonly disabled: boolean;
  readonly idPrefix?: string;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
  readonly onUpdate: (index: number, patch: Partial<ContactFormDraft['phones'][number]>) => void;
  readonly onPromote: (index: number) => void;
}

export function PhoneListEditor(props: PhoneListEditorProps): JSX.Element {
  const { t } = useTranslation();
  const prefix = props.idPrefix ?? 'c';
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t('entity.contacts.fieldPhones')}</legend>
      {props.drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('entity.contacts.phonesEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {props.drafts.map((p, i) => (
            <li key={`phone-${i}`} className="grid grid-cols-1 gap-2 md:grid-cols-6">
              <div className="space-y-1 md:col-span-3">
                <Label htmlFor={`${prefix}-phone-value-${i}`}>
                  {t('entity.contacts.fieldPhoneValue')}
                </Label>
                <Input
                  id={`${prefix}-phone-value-${i}`}
                  type="tel"
                  value={p.value}
                  onChange={(ev) => props.onUpdate(i, { value: ev.target.value })}
                  disabled={props.disabled}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor={`${prefix}-phone-label-${i}`}>
                  {t('entity.contacts.fieldPhoneLabel')}
                </Label>
                <Input
                  id={`${prefix}-phone-label-${i}`}
                  value={p.label}
                  onChange={(ev) => props.onUpdate(i, { label: ev.target.value })}
                  disabled={props.disabled}
                  autoComplete="off"
                />
              </div>
              <div className="flex items-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={p.isPrimary ? 'default' : 'ghost'}
                  onClick={() => props.onPromote(i)}
                  disabled={props.disabled}
                  aria-pressed={p.isPrimary}
                  title={t('entity.contacts.fieldPhonePrimary')}
                >
                  {t('entity.contacts.fieldPhonePrimary')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => props.onRemove(i)}
                  disabled={props.disabled}
                  aria-label={t('entity.contacts.fieldPhoneRemove')}
                >
                  {t('entity.contacts.fieldPhoneRemove')}
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
        {t('entity.contacts.fieldPhoneAdd')}
      </Button>
    </fieldset>
  );
}
