import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminPageShell } from '../../components/admin/AdminPageShell';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { getAdminObservabilityChatRun, listAdminObservabilityChatRuns } from '../../lib/api';
import type {
  AdminObservabilityChatRunDetail,
  AdminObservabilityChatRunLinkedLlmCall,
  AdminObservabilityChatRunRow,
  AdminObservabilityChatRunStep,
  AdminObservabilityChatRunsFilter,
} from '../../lib/api-types';
import { errorKeyOf } from '../../lib/errors';

/**
 * Phase 4 of `docs/dev/plans/admin-observability-viewer.md` —
 * `/admin/observability/chat-runs`.
 *
 * Read-only viewer for the chat pipeline runs (`chat_pipeline_runs`
 * + per-step `chat_pipeline_steps`). Mirrors the Phase 2/3 shell +
 * filter form + cursor pagination + detail drawer; the drawer
 * renders a step timeline (CSS bars — no chart lib) plus a linked
 * `llm_calls` table joined by `correlation_id`.
 *
 * Redaction audit gate
 * (`docs/dev/audits/admin-observability-redaction-2026-05-25.md`):
 *   - `chat_pipeline_steps.input_json` for the `intent` and
 *     `entities` step kinds carries the raw user message by design.
 *     The default detail fetch suppresses both; an explicit "Show
 *     raw chat content" button re-fetches with `?raw=true`. That
 *     click is the only path that surfaces the raw user message and
 *     is logged server-side as
 *     `admin.observability.chat-runs.raw-content.viewed`.
 *   - Output JSON for every step kind is metadata-only by writer
 *     design (the `answer` step stores byte counts, not content) so
 *     it renders inline behind a collapsed `<details>` expander.
 *
 * Accessibility (plan §9 + §4-extra):
 *   - Table headers use `<th scope="col">`.
 *   - Status column carries an icon + text label (not color-only).
 *   - Filter form uses real `<label for>` associations.
 *   - Detail drawer reuses the existing `<dialog>`-based `Dialog`
 *     (focus trap, ESC dismiss, focus return) per Phase 2/3.
 *   - The raw-content warning lives inside a `role="alert"` region
 *     so screen readers announce it when the gate is opened.
 *   - JSON payloads render in `<pre tabindex="0">` so keyboard
 *     users can navigate them.
 */

interface FormState {
  layerId: string;
  userId: string;
  status: '' | 'ok' | 'err';
  from: string;
  to: string;
}

const EMPTY_FORM: FormState = {
  layerId: '',
  userId: '',
  status: '',
  from: '',
  to: '',
};

type LoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | {
      readonly kind: 'ready';
      readonly rows: readonly AdminObservabilityChatRunRow[];
      readonly nextCursor: string | null;
    };

type DetailState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly id: string }
  | { readonly kind: 'error'; readonly id: string; readonly errorKey: string }
  | { readonly kind: 'ready'; readonly data: AdminObservabilityChatRunDetail };

export function AdminChatRunsPage(): JSX.Element {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [appliedFilter, setAppliedFilter] = useState<AdminObservabilityChatRunsFilter>({});
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [detail, setDetail] = useState<DetailState>({ kind: 'idle' });
  const [revealingRaw, setRevealingRaw] = useState(false);

  const load = useCallback(
    async (filter: AdminObservabilityChatRunsFilter, mode: 'replace' | 'append'): Promise<void> => {
      if (mode === 'replace') setState({ kind: 'loading' });
      try {
        const res = await listAdminObservabilityChatRuns(filter);
        setState((prev) => {
          if (mode === 'append' && prev.kind === 'ready') {
            return {
              kind: 'ready',
              rows: [...prev.rows, ...res.rows],
              nextCursor: res.nextCursor,
            };
          }
          return { kind: 'ready', rows: res.rows, nextCursor: res.nextCursor };
        });
      } catch (err: unknown) {
        setState({ kind: 'error', errorKey: errorKeyOf(err) });
      }
    },
    [],
  );

  useEffect(() => {
    void load(appliedFilter, 'replace');
  }, [appliedFilter, load]);

  function onApply(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const next: {
      layerId?: string;
      userId?: string;
      status?: 'ok' | 'err';
      from?: string;
      to?: string;
    } = {};
    if (form.layerId.trim() !== '') next.layerId = form.layerId.trim();
    if (form.userId.trim() !== '') next.userId = form.userId.trim();
    if (form.status !== '') next.status = form.status;
    if (form.from.trim() !== '') next.from = form.from.trim();
    if (form.to.trim() !== '') next.to = form.to.trim();
    setAppliedFilter(next);
  }

  function onReset(): void {
    setForm(EMPTY_FORM);
    setAppliedFilter({});
  }

  function onLoadMore(): void {
    if (state.kind !== 'ready' || state.nextCursor === null) return;
    void load({ ...appliedFilter, cursor: state.nextCursor }, 'append');
  }

  function onRefresh(): void {
    void load(appliedFilter, 'replace');
  }

  async function onOpenDetail(row: AdminObservabilityChatRunRow): Promise<void> {
    setDetail({ kind: 'loading', id: row.id });
    setRevealingRaw(false);
    try {
      const data = await getAdminObservabilityChatRun(row.id);
      setDetail({ kind: 'ready', data });
    } catch (err: unknown) {
      setDetail({ kind: 'error', id: row.id, errorKey: errorKeyOf(err) });
    }
  }

  function onCloseDetail(): void {
    setDetail({ kind: 'idle' });
    setRevealingRaw(false);
  }

  async function onRevealRawContent(): Promise<void> {
    if (detail.kind !== 'ready') return;
    const id = detail.data.id;
    setRevealingRaw(true);
    try {
      const data = await getAdminObservabilityChatRun(id, { raw: true });
      setDetail({ kind: 'ready', data });
    } catch (err: unknown) {
      setDetail({ kind: 'error', id, errorKey: errorKeyOf(err) });
    } finally {
      setRevealingRaw(false);
    }
  }

  return (
    <>
      <AdminPageShell
        title={t('admin.chatRuns.title')}
        actions={
          <Button type="button" variant="ghost" size="sm" onClick={onRefresh}>
            {t('admin.chatRuns.refresh')}
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">{t('admin.chatRuns.description')}</p>

        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          aria-label={t('admin.chatRuns.filters.label')}
          onSubmit={onApply}
          onReset={onReset}
        >
          <FilterField
            id="adminChatRunsLayer"
            label={t('admin.chatRuns.filters.layerId')}
            value={form.layerId}
            onChange={(v) => setForm((f) => ({ ...f, layerId: v }))}
          />
          <FilterField
            id="adminChatRunsUser"
            label={t('admin.chatRuns.filters.userId')}
            value={form.userId}
            onChange={(v) => setForm((f) => ({ ...f, userId: v }))}
          />
          <div className="space-y-1">
            <Label htmlFor="adminChatRunsStatus">{t('admin.chatRuns.filters.status')}</Label>
            <select
              id="adminChatRunsStatus"
              className="flex h-9 w-full rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={form.status}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'ok' || v === 'err' || v === '') {
                  setForm((f) => ({ ...f, status: v }));
                }
              }}
            >
              <option value="">{t('admin.chatRuns.filters.statusAll')}</option>
              <option value="ok">{t('admin.chatRuns.filters.statusOk')}</option>
              <option value="err">{t('admin.chatRuns.filters.statusErr')}</option>
            </select>
          </div>
          <FilterField
            id="adminChatRunsFrom"
            label={t('admin.chatRuns.filters.from')}
            type="datetime-local"
            value={form.from}
            onChange={(v) => setForm((f) => ({ ...f, from: v }))}
          />
          <FilterField
            id="adminChatRunsTo"
            label={t('admin.chatRuns.filters.to')}
            type="datetime-local"
            value={form.to}
            onChange={(v) => setForm((f) => ({ ...f, to: v }))}
          />
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="reset" variant="ghost" size="sm">
              {t('admin.chatRuns.filters.reset')}
            </Button>
            <Button type="submit" size="sm">
              {t('admin.chatRuns.filters.apply')}
            </Button>
          </div>
        </form>

        <div className="mt-6">
          {state.kind === 'loading' ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('common.loading')}
            </p>
          ) : null}
          {state.kind === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {t(state.errorKey, { defaultValue: t('errors.network') })}
            </p>
          ) : null}
          {state.kind === 'ready' && state.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('admin.chatRuns.empty')}</p>
          ) : null}
          {state.kind === 'ready' && state.rows.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.chatRuns.columns.startedAt')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.chatRuns.columns.duration')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.chatRuns.columns.layer')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.chatRuns.columns.user')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.chatRuns.columns.steps')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.chatRuns.columns.errors')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.chatRuns.columns.status')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        <span className="sr-only">{t('admin.chatRuns.columns.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.rows.map((row) => (
                      <tr key={row.id} className="border-b last:border-0">
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.startedAt}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.durationMs === null ? '—' : `${row.durationMs} ms`}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.layerId ?? '—'}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.userId ?? '—'}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.stepCount}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.errorCount}
                        </td>
                        <td className="px-2 py-2 text-xs">
                          <StatusBadge status={row.status} />
                        </td>
                        <td className="px-2 py-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void onOpenDetail(row)}
                          >
                            {t('admin.chatRuns.viewDetail')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex justify-end">
                {state.nextCursor !== null ? (
                  <Button type="button" size="sm" variant="ghost" onClick={onLoadMore}>
                    {t('admin.chatRuns.loadMore')}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t('admin.chatRuns.endOfResults')}
                  </span>
                )}
              </div>
            </>
          ) : null}
        </div>
      </AdminPageShell>

      <Dialog
        open={detail.kind !== 'idle'}
        onClose={onCloseDetail}
        title={
          detail.kind === 'ready'
            ? `${t('admin.chatRuns.detail.title')} · ${detail.data.startedAt}`
            : t('admin.chatRuns.detail.title')
        }
        closeLabel={t('common.close')}
      >
        {detail.kind === 'loading' ? (
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        ) : null}
        {detail.kind === 'error' ? (
          <p role="alert" className="text-sm text-destructive">
            {t(detail.errorKey, { defaultValue: t('errors.network') })}
          </p>
        ) : null}
        {detail.kind === 'ready' ? (
          <DetailBody
            detail={detail.data}
            revealingRaw={revealingRaw}
            onRevealRaw={() => void onRevealRawContent()}
          />
        ) : null}
      </Dialog>
    </>
  );
}

interface FilterFieldProps {
  readonly id: string;
  readonly label: string;
  readonly type?: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}

function FilterField(props: FilterFieldProps): JSX.Element {
  const { id, label, type, value, onChange } = props;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function StatusBadge({ status }: { readonly status: 'ok' | 'err' }): JSX.Element {
  const { t } = useTranslation();
  if (status === 'err') {
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        <span aria-hidden="true">{'✕'}</span>
        <span>{t('admin.chatRuns.status.err')}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-foreground">
      <span aria-hidden="true">{'✓'}</span>
      <span>{t('admin.chatRuns.status.ok')}</span>
    </span>
  );
}

function DetailBody({
  detail,
  revealingRaw,
  onRevealRaw,
}: {
  readonly detail: AdminObservabilityChatRunDetail;
  readonly revealingRaw: boolean;
  readonly onRevealRaw: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  // Total run duration (ms) for the step-timeline bars. Fall back to
  // the sum of step durations when the run has no `ended_at`.
  const runStart = Date.parse(detail.startedAt);
  const fallbackEnd = detail.steps.reduce<number>((acc, s) => {
    if (s.endedAt === null) return acc;
    const end = Date.parse(s.endedAt);
    return Number.isFinite(end) ? Math.max(acc, end) : acc;
  }, runStart);
  const runEnd = detail.endedAt !== null ? Date.parse(detail.endedAt) : fallbackEnd;
  const runSpanMs = Math.max(1, runEnd - runStart);
  const anyGated = detail.steps.some((s) => s.inputGated);

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <DetailRow label={t('admin.chatRuns.detail.id')} value={detail.id} />
        <DetailRow label={t('admin.chatRuns.detail.messageId')} value={detail.messageId} />
        <DetailRow label={t('admin.chatRuns.detail.runStatus')} value={detail.runStatus} />
        <DetailRow
          label={t('admin.chatRuns.detail.durationMs')}
          value={detail.durationMs === null ? '—' : `${detail.durationMs}`}
        />
        <DetailRow label={t('admin.chatRuns.detail.layerId')} value={detail.layerId ?? '—'} />
        <DetailRow label={t('admin.chatRuns.detail.userId')} value={detail.userId ?? '—'} />
        <DetailRow
          label={t('admin.chatRuns.detail.conversationId')}
          value={detail.conversationId ?? '—'}
        />
        <DetailRow
          label={t('admin.chatRuns.detail.correlationId')}
          value={detail.correlationId ?? '—'}
        />
        <DetailRow label={t('admin.chatRuns.detail.flowId')} value={detail.flowId ?? '—'} />
      </dl>

      {anyGated && !detail.rawIncluded ? (
        <RawContentGate revealingRaw={revealingRaw} onReveal={onRevealRaw} />
      ) : null}
      {detail.rawIncluded ? <RawContentNotice /> : null}

      <StepTimeline runStart={runStart} runSpanMs={runSpanMs} steps={detail.steps} />

      <LinkedLlmCallsSection calls={detail.linkedLlmCalls} />
    </div>
  );
}

function DetailRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs break-all">{value}</dd>
    </div>
  );
}

/**
 * Single-button gate for the gated `intent` / `entities` step
 * `input_json`. Lives inside `role="alert"` so the screen-reader
 * announces the warning as soon as the drawer renders the gate.
 * Clicking the button is a deliberate admin action; the server logs
 * the action as `admin.observability.chat-runs.raw-content.viewed`.
 */
function RawContentGate({
  revealingRaw,
  onReveal,
}: {
  readonly revealingRaw: boolean;
  readonly onReveal: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div role="alert" className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        {t('admin.chatRuns.detail.rawContent.warningTitle')}
      </p>
      <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-200/80">
        {t('admin.chatRuns.detail.rawContent.warningBody')}
      </p>
      <div className="mt-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onReveal}
          disabled={revealingRaw}
        >
          {revealingRaw
            ? t('admin.chatRuns.detail.rawContent.loading')
            : t('admin.chatRuns.detail.rawContent.show')}
        </Button>
      </div>
    </div>
  );
}

function RawContentNotice(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div role="status" aria-live="polite" className="rounded-md border bg-muted/40 px-3 py-2">
      <p className="text-xs text-muted-foreground">
        {t('admin.chatRuns.detail.rawContent.revealed')}
      </p>
    </div>
  );
}

/**
 * Per-step Gantt-ish timeline. CSS only — width is computed against
 * the run's total span. Each row is a button so a future "expand
 * step JSON" interaction can hang off it without re-shuffling the
 * DOM. Status carries an icon + text label per plan §9.
 */
function StepTimeline({
  runStart,
  runSpanMs,
  steps,
}: {
  readonly runStart: number;
  readonly runSpanMs: number;
  readonly steps: readonly AdminObservabilityChatRunStep[];
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="chatRunSteps" className="space-y-2">
      <h3
        id="chatRunSteps"
        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {t('admin.chatRuns.detail.steps')}
      </h3>
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('admin.chatRuns.detail.stepsEmpty')}</p>
      ) : (
        <ol className="space-y-2">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} runStart={runStart} runSpanMs={runSpanMs} />
          ))}
        </ol>
      )}
    </section>
  );
}

function StepRow({
  step,
  runStart,
  runSpanMs,
}: {
  readonly step: AdminObservabilityChatRunStep;
  readonly runStart: number;
  readonly runSpanMs: number;
}): JSX.Element {
  const { t } = useTranslation();
  const stepStart = Date.parse(step.startedAt);
  const stepEnd = step.endedAt === null ? stepStart : Date.parse(step.endedAt);
  const offset = Math.max(0, stepStart - runStart);
  const length = Math.max(0, stepEnd - stepStart);
  const offsetPct = Math.min(100, (offset / runSpanMs) * 100);
  // Keep a hairline (min-width via inline style) for zero-duration
  // steps so the timeline doesn't visually collapse to a single dot.
  const widthPct = Math.max(0.5, Math.min(100 - offsetPct, (length / runSpanMs) * 100));
  return (
    <li className="rounded-md border bg-card/30 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-mono text-xs font-medium">{step.kind}</p>
        <p className="text-xs text-muted-foreground">
          {step.durationMs === null
            ? t('admin.chatRuns.detail.durationPending')
            : t('admin.chatRuns.detail.durationFormatted', { ms: step.durationMs })}
        </p>
      </div>
      <div
        className="mt-2 h-2 w-full rounded-full bg-muted"
        aria-label={t('admin.chatRuns.detail.stepBarLabel', {
          kind: step.kind,
          ms: step.durationMs ?? 0,
        })}
      >
        <div
          className={
            'h-full rounded-full ' + (step.errorCode !== null ? 'bg-destructive' : 'bg-primary/70')
          }
          style={{ marginLeft: `${offsetPct}%`, width: `${widthPct}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <StepStatusBadge status={step.status} hasError={step.errorCode !== null} />
        <span>{t('admin.chatRuns.detail.attempt', { attempt: step.attempt })}</span>
        {step.llmCallId !== null ? (
          <span className="font-mono">{`llm: ${step.llmCallId}`}</span>
        ) : null}
        {step.errorCode !== null ? (
          <span className="text-destructive">{`${t('admin.chatRuns.detail.errorCode')}: ${step.errorCode}`}</span>
        ) : null}
      </div>

      {step.inputGated ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          {t('admin.chatRuns.detail.inputGatedHint', { bytes: step.inputBytes })}
        </p>
      ) : (
        <CollapsibleJson label={t('admin.chatRuns.detail.inputJson')} raw={step.inputJson} />
      )}
      <CollapsibleJson label={t('admin.chatRuns.detail.outputJson')} raw={step.outputJson} />
      {step.attributionJson !== null ? (
        <CollapsibleJson
          label={t('admin.chatRuns.detail.attributionJson')}
          raw={step.attributionJson}
        />
      ) : null}
    </li>
  );
}

function StepStatusBadge({
  status,
  hasError,
}: {
  readonly status: string;
  readonly hasError: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  if (hasError || status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        <span aria-hidden="true">{'✕'}</span>
        <span>{t('admin.chatRuns.detail.stepStatus.failed')}</span>
      </span>
    );
  }
  if (status === 'succeeded') {
    return (
      <span className="inline-flex items-center gap-1 text-foreground">
        <span aria-hidden="true">{'✓'}</span>
        <span>{t('admin.chatRuns.detail.stepStatus.succeeded')}</span>
      </span>
    );
  }
  if (status === 'skipped') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <span aria-hidden="true">{'∼'}</span>
        <span>{t('admin.chatRuns.detail.stepStatus.skipped')}</span>
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <span aria-hidden="true">{'…'}</span>
        <span>{t('admin.chatRuns.detail.stepStatus.running')}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <span aria-hidden="true">{'·'}</span>
      <span>{status}</span>
    </span>
  );
}

/**
 * Collapsed-by-default JSON expander. Mirrors the Phase 3 LLM-calls
 * drawer pattern: `<details>` provides keyboard + ARIA semantics
 * for free, and `<pre tabindex="0">` keeps the payload navigable.
 */
function CollapsibleJson({
  label,
  raw,
}: {
  readonly label: string;
  readonly raw: string | null;
}): JSX.Element {
  const { t } = useTranslation();
  if (raw === null || raw === '') {
    return (
      <div className="mt-2 space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{t('admin.chatRuns.detail.empty')}</p>
      </div>
    );
  }
  let pretty = raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    pretty = JSON.stringify(parsed, null, 2);
  } catch {
    // Non-JSON — render verbatim.
  }
  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          {t('admin.chatRuns.detail.expandJson')}
        </summary>
        <pre
          tabIndex={0}
          className="mt-2 max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-snug"
        >
          {pretty}
        </pre>
      </details>
    </div>
  );
}

function LinkedLlmCallsSection({
  calls,
}: {
  readonly calls: readonly AdminObservabilityChatRunLinkedLlmCall[];
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="chatRunLinkedLlmCalls" className="space-y-1">
      <h3
        id="chatRunLinkedLlmCalls"
        className="text-xs uppercase tracking-wide text-muted-foreground"
      >
        {t('admin.chatRuns.detail.linkedLlmCalls')}
      </h3>
      {calls.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('admin.chatRuns.detail.linkedLlmCallsEmpty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('admin.chatRuns.detail.linkedLlmCallsColumns.startedAt')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('admin.chatRuns.detail.linkedLlmCallsColumns.model')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('admin.chatRuns.detail.linkedLlmCallsColumns.endpoint')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('admin.chatRuns.detail.linkedLlmCallsColumns.latencyMs')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('admin.chatRuns.detail.linkedLlmCallsColumns.costUsd')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('admin.chatRuns.detail.linkedLlmCallsColumns.status')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('admin.chatRuns.detail.linkedLlmCallsColumns.id')}
                </th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="px-2 py-1 font-mono text-muted-foreground">{c.startedAt}</td>
                  <td className="px-2 py-1 font-mono">{c.model}</td>
                  <td className="px-2 py-1 font-mono text-muted-foreground">{c.endpoint}</td>
                  <td className="px-2 py-1 font-mono text-muted-foreground">
                    {c.latencyMs === null ? '—' : `${c.latencyMs}`}
                  </td>
                  <td className="px-2 py-1 font-mono text-muted-foreground">
                    {c.costUsd === null ? '—' : `$${c.costUsd.toFixed(4)}`}
                  </td>
                  <td className="px-2 py-1">
                    <StatusBadge status={c.hasError ? 'err' : 'ok'} />
                  </td>
                  <td className="px-2 py-1 font-mono text-muted-foreground">{c.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
