import { useTranslation } from 'react-i18next';
import type { EntitySummary } from '../../lib/api-types';
import { Button } from '../ui/button';
import { Label } from '../ui/label';

/**
 * Shared company-link picker. Lifted from `ContactDetailPage.tsx` in
 * the `contacts-manual-create` follow-up so both the detail page and
 * the create dialog render the same control.
 *
 * A plain `<select>` populated from the layer's companies. Accessible
 * out of the box (keyboard + screen reader). The "Clear" button sets
 * the value to `null`, omitting the field from the next request.
 *
 * If the value points at an id that is not in the loaded companies
 * list (deleted, hidden, or not yet fetched), the picker still renders
 * it as a disabled option labelled "unknown" so the user does not
 * silently lose the link on save — they can clear it explicitly.
 */
export interface CompanyPickerProps {
  readonly value: string | null;
  readonly companies: readonly EntitySummary[];
  readonly disabled: boolean;
  readonly idPrefix?: string;
  readonly onChange: (next: string | null) => void;
}

export function CompanyPicker(props: CompanyPickerProps): JSX.Element {
  const { t } = useTranslation();
  const prefix = props.idPrefix ?? 'c';
  const inListed = props.companies.some((c) => c.id === props.value);
  return (
    <div className="space-y-2">
      <Label htmlFor={`${prefix}-company`}>{t('entity.contacts.fieldCompany')}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={`${prefix}-company`}
          value={props.value ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            props.onChange(v.length === 0 ? null : v);
          }}
          disabled={props.disabled}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">{t('entity.contacts.fieldCompanyPlaceholder')}</option>
          {props.value !== null && !inListed ? (
            <option value={props.value}>
              {t('entity.contacts.fieldCompanyUnknown', { id: props.value })}
            </option>
          ) : null}
          {props.companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
              {c.subtitle !== null ? ` · ${c.subtitle}` : ''}
            </option>
          ))}
        </select>
        {props.value !== null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => props.onChange(null)}
            disabled={props.disabled}
          >
            {t('entity.contacts.fieldCompanyClear')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
