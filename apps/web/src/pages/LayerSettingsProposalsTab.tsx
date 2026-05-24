/**
 * Phase 8.4 — Proposals tab on the Layer Settings page.
 *
 * Hosts the five admin-tunable auto-activation knobs (ADR 0026 §1,
 * plan §4.4): enable flag, threshold cutoff, cooldown hours,
 * thumbs-up-delta-positive requirement, optional max-tokens-delta
 * cap. The form is rendered disabled (not hidden) for non-admins —
 * mirrors the General / Locales tabs and keeps the surface
 * discoverable.
 *
 * The route round-trip exposes a `source: 'default' | 'saved'`
 * discriminator the panel header surfaces above the form ("using
 * defaults" vs. "saved on …"). After a successful save the response
 * is the new `source: 'saved'` payload — we adopt it directly
 * instead of refetching.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import {
  fetchLayerProposalSettings,
  saveLayerProposalSettings,
  type LayerProposalSettingsInput,
  type LayerProposalSettingsResponse,
} from '../lib/api';
import type { Layer } from '../lib/api-types';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';

interface Props {
  readonly layer: Layer;
  readonly canEdit: boolean;
}

interface FormState {
  readonly autoActivationEnabled: boolean;
  readonly thresholdCutoff: string;
  readonly cooldownHours: string;
  readonly requireThumbsUpDeltaPositive: boolean;
  readonly capTokensDelta: boolean;
  readonly maxTokensDelta: string;
}

function toForm(input: LayerProposalSettingsResponse['settings']): FormState {
  return {
    autoActivationEnabled: input.autoActivationEnabled,
    thresholdCutoff: input.thresholdCutoff.toString(),
    cooldownHours: input.cooldownHours.toString(),
    requireThumbsUpDeltaPositive: input.requireThumbsUpDeltaPositive,
    capTokensDelta: input.maxTokensDelta !== null,
    maxTokensDelta: input.maxTokensDelta === null ? '' : input.maxTokensDelta.toString(),
  };
}

function validate(
  form: FormState,
): { kind: 'ok'; input: LayerProposalSettingsInput } | { kind: 'err' } {
  const cutoff = Number.parseFloat(form.thresholdCutoff);
  const cooldown = Number.parseInt(form.cooldownHours, 10);
  if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff > 1) return { kind: 'err' };
  if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 720) return { kind: 'err' };
  let maxTokensDelta: number | null = null;
  if (form.capTokensDelta) {
    const cap = Number.parseInt(form.maxTokensDelta, 10);
    if (!Number.isInteger(cap) || cap < 0) return { kind: 'err' };
    maxTokensDelta = cap;
  }
  return {
    kind: 'ok',
    input: {
      autoActivationEnabled: form.autoActivationEnabled,
      thresholdCutoff: cutoff,
      cooldownHours: cooldown,
      requireThumbsUpDeltaPositive: form.requireThumbsUpDeltaPositive,
      maxTokensDelta,
    },
  };
}

export function LayerSettingsProposalsTab(props: Props): JSX.Element {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<LayerProposalSettingsResponse | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetchLayerProposalSettings(props.layer.slug);
      setLoaded(res);
      setForm(toForm(res.settings));
    } catch (err) {
      setLoadError(errorKeyOf(err));
    }
  }, [props.layer.slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      if (form === null || pending || !props.canEdit) return;
      setSaveError(null);
      setValidationError(null);
      const v = validate(form);
      if (v.kind === 'err') {
        setValidationError('layer.settings.proposals.errorOutOfRange');
        return;
      }
      setPending(true);
      try {
        const res = await saveLayerProposalSettings(props.layer.slug, v.input);
        setLoaded(res);
        setForm(toForm(res.settings));
        pushToast({ kind: 'success', message: t('layer.settings.proposals.savedToast') });
      } catch (err) {
        setSaveError(errorKeyOf(err));
      } finally {
        setPending(false);
      }
    },
    [form, pending, props.canEdit, props.layer.slug, t],
  );

  const handleCancel = useCallback(() => {
    if (loaded === null) return;
    setForm(toForm(loaded.settings));
    setSaveError(null);
    setValidationError(null);
  }, [loaded]);

  if (loadError !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t(loadError, { defaultValue: t('layer.settings.proposals.errorNetwork') })}
      </p>
    );
  }
  if (form === null || loaded === null) {
    return (
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </p>
    );
  }

  const disabled = !props.canEdit || pending;
  const sourceLine =
    loaded.source === 'default'
      ? t('layer.settings.proposals.sourceDefault')
      : t('layer.settings.proposals.sourceSaved', {
          updatedAt: loaded.settings.updatedAt,
          updatedBy: loaded.settings.updatedBy,
        });

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
      <p className="text-sm text-muted-foreground">
        {t('layer.settings.proposals.pageDescription')}
      </p>
      <p className="text-xs text-muted-foreground">{sourceLine}</p>

      <fieldset className="space-y-2" disabled={disabled}>
        <div className="flex items-center gap-2">
          <input
            id="lps-enabled"
            type="checkbox"
            className="h-4 w-4"
            checked={form.autoActivationEnabled}
            onChange={(e) =>
              setForm({
                ...form,
                autoActivationEnabled: e.target.checked,
              })
            }
            disabled={disabled}
          />
          <Label htmlFor="lps-enabled">{t('layer.settings.proposals.enabledLabel')}</Label>
        </div>
        <p id="lps-enabled-desc" className="text-xs text-muted-foreground">
          {t('layer.settings.proposals.enabledDescription')}
        </p>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="lps-cutoff">{t('layer.settings.proposals.thresholdCutoffLabel')}</Label>
        <Input
          id="lps-cutoff"
          type="number"
          step={0.01}
          min={0}
          max={1}
          value={form.thresholdCutoff}
          onChange={(e) => setForm({ ...form, thresholdCutoff: e.target.value })}
          disabled={disabled}
          aria-describedby="lps-cutoff-desc"
        />
        <p id="lps-cutoff-desc" className="text-xs text-muted-foreground">
          {t('layer.settings.proposals.thresholdCutoffDescription')}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="lps-cooldown">{t('layer.settings.proposals.cooldownHoursLabel')}</Label>
        <Input
          id="lps-cooldown"
          type="number"
          step={1}
          min={0}
          max={720}
          value={form.cooldownHours}
          onChange={(e) => setForm({ ...form, cooldownHours: e.target.value })}
          disabled={disabled}
          aria-describedby="lps-cooldown-desc"
        />
        <p id="lps-cooldown-desc" className="text-xs text-muted-foreground">
          {t('layer.settings.proposals.cooldownHoursDescription')}
        </p>
      </div>

      <fieldset className="space-y-2" disabled={disabled}>
        <div className="flex items-center gap-2">
          <input
            id="lps-tudp"
            type="checkbox"
            className="h-4 w-4"
            checked={form.requireThumbsUpDeltaPositive}
            onChange={(e) =>
              setForm({
                ...form,
                requireThumbsUpDeltaPositive: e.target.checked,
              })
            }
            disabled={disabled}
          />
          <Label htmlFor="lps-tudp">
            {t('layer.settings.proposals.requireThumbsUpDeltaLabel')}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <input
            id="lps-cap"
            type="checkbox"
            className="h-4 w-4"
            checked={form.capTokensDelta}
            onChange={(e) => setForm({ ...form, capTokensDelta: e.target.checked })}
            disabled={disabled}
          />
          <Label htmlFor="lps-cap">{t('layer.settings.proposals.maxTokensDeltaCapLabel')}</Label>
          <Input
            id="lps-max-tokens"
            type="number"
            step={1}
            min={0}
            value={form.maxTokensDelta}
            onChange={(e) => setForm({ ...form, maxTokensDelta: e.target.value })}
            disabled={disabled || !form.capTokensDelta}
            aria-label={t('layer.settings.proposals.maxTokensDeltaLabel')}
            className="w-32"
          />
        </div>
      </fieldset>

      {validationError !== null ? (
        <p role="alert" aria-live="polite" className="text-sm text-destructive">
          {t(validationError)}
        </p>
      ) : null}
      {saveError !== null ? (
        <p role="alert" aria-live="polite" className="text-sm text-destructive">
          {t(saveError, { defaultValue: t('layer.settings.proposals.errorNetwork') })}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={handleCancel} disabled={disabled}>
          {t('layer.settings.proposals.cancelCta')}
        </Button>
        <Button type="submit" disabled={disabled}>
          {t('layer.settings.proposals.saveCta')}
        </Button>
      </div>
    </form>
  );
}
