/**
 * Phase 7.6 — `/l/:layerSlug/proposals/:id` detail page.
 *
 * Mirrors the ASCII wireframe in plan §4.6:
 *   - Header with back-link + kind badge + threshold pill.
 *   - Problem + supporting messages.
 *   - Proposed fix (compact summary of spec).
 *   - Expected impact (three deltas).
 *   - Sandbox evidence (current vs proposed).
 *   - Action bar: Approve / Reject / Replay sandbox (admin-only).
 *
 * The admin gate is `current.canEdit`; the server re-checks
 * `canEditLayer` on every mutation, so this is purely a UI affordance.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { trackEvent } from '../lib/analytics';
import { useCurrentLayer } from '../lib/use-current-layer';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';
import {
  approveLayerProposal,
  ApiError,
  rejectLayerProposal,
  replayProposalSandbox,
  rollbackLayerProposal,
  type ProposalArtifactItem,
  type ProposalDetailResponse,
  type ProposalEvidenceItem,
} from '../lib/api';
import { AutoActivationDecisionSchema, type AutoActivationDecision } from '@bunny2/shared';
import { useLayerProposalDetail, formatImpactDelta } from './layer-proposals-page-state';

export function LayerProposalDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const current = useCurrentLayer();
  const params = useParams<{ id: string }>();
  const proposalId = params.id ?? '';
  const layerSlug = current.status === 'ready' ? current.layer.slug : null;
  const canEdit = current.status === 'ready' ? current.canEdit : false;
  const state = useLayerProposalDetail(layerSlug ?? '', proposalId);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);

  useMemo(() => {
    if (layerSlug === null) return;
    trackEvent('proposal_detail_opened', { layerSlug, proposalId });
  }, [layerSlug, proposalId]);

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="p-4 text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }
  const slug = current.layer.slug;

  return (
    <div className="space-y-4">
      <div>
        <Link to={`/l/${slug}/proposals`} className="text-sm text-muted-foreground hover:underline">
          ← {t('proposals.detail.backToList')}
        </Link>
      </div>
      {state.status === 'loading' ? (
        <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {t('proposals.detail.loading')}
        </div>
      ) : null}
      {state.status === 'error' ? (
        <div role="alert" className="text-sm text-destructive">
          {t('proposals.detail.errorLoadFailed')}
          <span className="sr-only">{` (${state.errorKey ?? ''})`}</span>
        </div>
      ) : null}
      {state.status === 'ready' && state.data !== null ? (
        <ProposalDetailView
          data={state.data}
          layerSlug={slug}
          canEdit={canEdit}
          onChange={state.reload}
          onOpenReject={() => setRejectOpen(true)}
          onOpenRollback={() => setRollbackOpen(true)}
        />
      ) : null}
      {rejectOpen && state.data !== null ? (
        <RejectDialog
          layerSlug={slug}
          proposalId={state.data.proposal.id}
          onClose={() => setRejectOpen(false)}
          onDone={() => {
            setRejectOpen(false);
            state.reload();
          }}
        />
      ) : null}
      {rollbackOpen && state.data !== null ? (
        <RollbackDialog
          layerSlug={slug}
          proposalId={state.data.proposal.id}
          onClose={() => setRollbackOpen(false)}
          onDone={() => {
            setRollbackOpen(false);
            state.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function ProposalDetailView({
  data,
  layerSlug,
  canEdit,
  onChange,
  onOpenReject,
  onOpenRollback,
}: {
  readonly data: ProposalDetailResponse;
  readonly layerSlug: string;
  readonly canEdit: boolean;
  readonly onChange: () => void;
  readonly onOpenReject: () => void;
  readonly onOpenRollback: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const proposal = data.proposal;
  const expected = proposal.expectedImpact ?? {};
  const [approving, setApproving] = useState(false);
  const [replaying, setReplaying] = useState(false);

  const handleApprove = useCallback(async () => {
    setApproving(true);
    try {
      const res = await approveLayerProposal(layerSlug, proposal.id);
      trackEvent('proposal_approved', {
        layerSlug,
        proposalId: proposal.id,
        outcome: res.outcome,
      });
      pushToast({
        kind: 'success',
        message: outcomeI18nKey(res.outcome),
      });
      onChange();
    } catch (err) {
      pushToast({ kind: 'error', message: errorKeyOf(err) });
    } finally {
      setApproving(false);
    }
  }, [layerSlug, proposal.id, onChange]);

  const handleReplay = useCallback(async () => {
    setReplaying(true);
    try {
      const res = await replayProposalSandbox(layerSlug, proposal.id);
      trackEvent('proposal_sandbox_replayed', {
        layerSlug,
        proposalId: proposal.id,
        outcome: res.outcome,
      });
      pushToast({ kind: 'success', message: 'proposals.detail.sandboxSectionTitle' });
      onChange();
    } catch (err) {
      pushToast({ kind: 'error', message: errorKeyOf(err) });
    } finally {
      setReplaying(false);
    }
  }, [layerSlug, proposal.id, onChange]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t(`proposals.kind.${proposal.artifactKind}`)} — {proposal.problemSummary}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border px-2 py-0.5 uppercase">
            {t(`proposals.status.${proposal.status}`)}
          </span>
          <span className="rounded-full border px-2 py-0.5">
            {t('proposals.detail.thresholdLabel')}: {proposal.threshold.toFixed(2)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {proposal.rolledBackAt !== null ? (
          <RollbackNotice
            rolledBackAt={proposal.rolledBackAt}
            rolledBackBy={proposal.rolledBackBy ?? ''}
            rolledBackReason={proposal.rolledBackReason ?? ''}
          />
        ) : null}
        <section>
          <h2 className="text-base font-semibold">{t('proposals.detail.problemSectionTitle')}</h2>
          <p className="mt-1 text-sm">{proposal.problemSummary}</p>
          {data.evidence.length > 0 ? (
            <div className="mt-2">
              <h3 className="text-sm font-medium">
                {t('proposals.detail.supportingMessagesTitle')}
              </h3>
              <ul className="mt-1 space-y-1 text-sm">
                {data.evidence.map((e) => (
                  <EvidenceLine key={e.id} ev={e} layerSlug={layerSlug} />
                ))}
              </ul>
            </div>
          ) : null}
        </section>
        <section>
          <h2 className="text-base font-semibold">
            {t('proposals.detail.proposedFixSectionTitle')}
          </h2>
          <SpecSummary spec={proposal.proposedSpec} />
        </section>
        <section>
          <h2 className="text-base font-semibold">
            {t('proposals.detail.expectedImpactSectionTitle')}
          </h2>
          <dl className="mt-1 grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-muted-foreground">{t('proposals.detail.thumbsUpDeltaLabel')}</dt>
              <dd className="tabular-nums">{formatImpactDelta(expected.thumbsUpDelta ?? 0)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('proposals.detail.tokensDeltaLabel')}</dt>
              <dd className="tabular-nums">{expected.tokensDelta ?? 0}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('proposals.detail.latencyDeltaLabel')}</dt>
              <dd className="tabular-nums">{`${expected.latencyDeltaMs ?? 0} ms`}</dd>
            </div>
          </dl>
        </section>
        <SandboxSection artifacts={data.artifacts} />
        {proposal.autoActivationDecisionJson !== null ? (
          <AutoActivationDecisionPanel decisionJson={proposal.autoActivationDecisionJson} />
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={handleApprove}
            disabled={!canEdit || approving || proposal.status !== 'new'}
            title={!canEdit ? t('proposals.detail.adminOnlyTooltip') : undefined}
          >
            {t('proposals.detail.approveCta')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onOpenReject}
            disabled={!canEdit || proposal.status !== 'new'}
            title={!canEdit ? t('proposals.detail.adminOnlyTooltip') : undefined}
          >
            {t('proposals.detail.rejectCta')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={handleReplay}
            disabled={!canEdit || replaying}
            title={!canEdit ? t('proposals.detail.adminOnlyTooltip') : undefined}
          >
            {t('proposals.detail.replaySandboxCta')}
          </Button>
          {proposal.status === 'activated' && proposal.rolledBackAt === null ? (
            <Button
              type="button"
              variant="destructive"
              onClick={onOpenRollback}
              disabled={!canEdit}
              title={!canEdit ? t('proposals.detail.adminOnlyTooltip') : undefined}
            >
              {t('proposals.rollback.cta')}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Phase 8.5 — small inline notice rendered at the top of the detail
 * card when the proposal carries a rollback audit row. The format key
 * interpolates the timestamp, the actor (currently the raw user id —
 * the detail page does not yet resolve user ids to display names; the
 * approve / reject sections also surface ids), and the reason text.
 * The reason is admin-audit content stored on the proposal row only
 * (ADR 0027 §3); we render it here for the human face on the trail
 * but never log or telemeter it.
 */
function RollbackNotice({
  rolledBackAt,
  rolledBackBy,
  rolledBackReason,
}: {
  readonly rolledBackAt: string;
  readonly rolledBackBy: string;
  readonly rolledBackReason: string;
}): JSX.Element {
  const { t } = useTranslation();
  // Use the locale's short date for readability; raw user id is OK
  // here because the detail page already renders ids elsewhere
  // (approvedBy / rejectedBy live on the same shape) and no user-name
  // resolver helper exists in the page today.
  const date = new Date(rolledBackAt).toLocaleString();
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-900"
    >
      {t('proposals.rollback.noticeFormat', {
        date,
        user: rolledBackBy,
        reason: rolledBackReason,
      })}
    </div>
  );
}

function EvidenceLine({
  ev,
  layerSlug,
}: {
  readonly ev: ProposalEvidenceItem;
  readonly layerSlug: string;
}): JSX.Element {
  const { t } = useTranslation();
  // TODO(follow-up): scroll-into-view picked up by chat-page-message-deep-link.md
  const href = `/l/${layerSlug}/chat?message=${encodeURIComponent(ev.messageId)}`;
  const preview = ev.messageContent ?? ev.messageId;
  return (
    <li>
      <Link to={href} className="hover:underline" aria-describedby={`reason-${ev.id}`}>
        {preview}
      </Link>{' '}
      <span id={`reason-${ev.id}`} className="text-xs text-muted-foreground">
        ({ev.clusterReason})
      </span>{' '}
      <span className="text-xs text-muted-foreground">
        — {t('proposals.detail.supportingMessageOpen')}
      </span>
    </li>
  );
}

function SpecSummary({ spec }: { readonly spec: unknown }): JSX.Element {
  if (spec === null || typeof spec !== 'object') {
    return <p className="text-sm text-muted-foreground">—</p>;
  }
  const s = spec as Record<string, unknown>;
  const name = typeof s.name === 'string' ? s.name : '';
  const description = typeof s.description === 'string' ? s.description : '';
  const intent = typeof s.intent === 'string' ? s.intent : null;
  const promptFragment = typeof s.promptFragment === 'string' ? s.promptFragment : null;
  return (
    <div className="mt-1 space-y-1 text-sm">
      {name !== '' ? <p className="font-medium">{name}</p> : null}
      {description !== '' ? <p className="text-muted-foreground">{description}</p> : null}
      {intent !== null ? <p className="text-xs">{`intent: ${intent}`}</p> : null}
      {promptFragment !== null ? (
        <pre className="whitespace-pre-wrap rounded-md border bg-muted p-2 text-xs">
          {promptFragment}
        </pre>
      ) : null}
    </div>
  );
}

function SandboxSection({
  artifacts,
}: {
  readonly artifacts: readonly ProposalArtifactItem[];
}): JSX.Element {
  const { t } = useTranslation();
  const current = artifacts.find((a) => a.variant === 'current');
  const proposed = artifacts.find((a) => a.variant === 'proposed');
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <section aria-labelledby="sandbox-current">
        <h2 id="sandbox-current" className="text-sm font-semibold">
          {t('proposals.detail.sandboxCurrentLabel')}
        </h2>
        <SandboxTranscript artifact={current} />
      </section>
      <section aria-labelledby="sandbox-proposed">
        <h2 id="sandbox-proposed" className="text-sm font-semibold">
          {t('proposals.detail.sandboxProposedLabel')}
        </h2>
        <SandboxTranscript artifact={proposed} />
      </section>
    </div>
  );
}

function SandboxTranscript({
  artifact,
}: {
  readonly artifact: ProposalArtifactItem | undefined;
}): JSX.Element {
  if (artifact === undefined) {
    return <p className="mt-1 text-sm text-muted-foreground">—</p>;
  }
  const transcript = artifact.transcript as {
    readonly messages?: Array<{
      readonly messageId?: string;
      readonly status?: string;
      readonly answerPreview?: string;
      readonly retrievalHits?: number;
    }>;
  };
  const messages = Array.isArray(transcript.messages) ? transcript.messages : [];
  return (
    <ol className="mt-1 space-y-1 text-sm">
      {messages.length === 0 ? (
        <li className="text-muted-foreground">—</li>
      ) : (
        messages.map((m, idx) => (
          <li key={m.messageId ?? idx} className="rounded-md border p-2">
            <details open>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {`#${idx + 1} · ${m.status ?? '?'} · ${m.retrievalHits ?? 0} hits`}
              </summary>
              <p className="mt-1 text-xs">{m.answerPreview ?? ''}</p>
            </details>
          </li>
        ))
      )}
    </ol>
  );
}

function RejectDialog({
  layerSlug,
  proposalId,
  onClose,
  onDone,
}: {
  readonly layerSlug: string;
  readonly proposalId: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el !== null && !el.open) el.showModal();
    return (): void => {
      if (el !== null && el.open) el.close();
    };
  }, []);

  const submit = useCallback(async () => {
    if (reason.trim().length === 0) return;
    setBusy(true);
    try {
      await rejectLayerProposal(layerSlug, proposalId, reason.trim());
      // No reason text in analytics — AGENTS.md §Privacy.
      trackEvent('proposal_rejected', {
        layerSlug,
        proposalId,
      });
      onDone();
    } catch (err) {
      pushToast({ kind: 'error', message: errorKeyOf(err) });
    } finally {
      setBusy(false);
    }
  }, [layerSlug, proposalId, reason, onDone]);

  return (
    <dialog
      ref={ref}
      aria-label={t('proposals.detail.rejectConfirm')}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="rounded-md border bg-background p-4 backdrop:bg-black/50"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex w-80 flex-col gap-3"
      >
        <label className="flex flex-col gap-1 text-sm">
          {t('proposals.detail.rejectReasonLabel')}
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('proposals.detail.rejectReasonPlaceholder')}
            maxLength={500}
            rows={4}
            className="rounded-md border bg-background p-2"
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy || reason.trim().length === 0}>
            {t('proposals.detail.rejectConfirm')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * Phase 8.5 — confirmation dialog with a required reason textarea.
 * Mirrors the shape of `RejectDialog` above (native `<dialog>`, the
 * same primitive `LayerProposalDetailPage` already uses) so we don't
 * introduce a new dialog component (constraint from §6 of the task).
 *
 * Validation: the Confirm button is disabled when `reason.trim()` is
 * shorter than 5 chars; once the user has typed something the inline
 * `aria-live="polite"` message announces the validation state without
 * stealing focus. The server re-validates `5..2000`.
 *
 * 409 responses (`errors.proposal.notActivated` /
 * `errors.proposal.alreadyDeactivated`) render an inline alert in the
 * dialog with the localized message; on other failures the toast path
 * fires (mirrors RejectDialog).
 */
function RollbackDialog({
  layerSlug,
  proposalId,
  onClose,
  onDone,
}: {
  readonly layerSlug: string;
  readonly proposalId: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [inlineErrorKey, setInlineErrorKey] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el !== null && !el.open) el.showModal();
    return (): void => {
      if (el !== null && el.open) el.close();
    };
  }, []);

  const trimmed = reason.trim();
  // 5 chars is the server's lower bound (`ProposalRollbackInputSchema`).
  const tooShort = trimmed.length > 0 && trimmed.length < 5;
  const canSubmit = trimmed.length >= 5 && !busy;

  const submit = useCallback(async () => {
    if (trimmed.length < 5) return;
    setBusy(true);
    setInlineErrorKey(null);
    try {
      await rollbackLayerProposal(layerSlug, proposalId, trimmed);
      // No reason text in analytics — ADR 0027 §3.
      trackEvent('proposal_rolled_back', { layerSlug, proposalId });
      pushToast({ kind: 'success', message: 'proposals.rollback.savedToast' });
      onDone();
    } catch (err) {
      // Surface the two server 409 codes inline in the dialog so the
      // admin gets context without losing the open dialog state.
      if (err instanceof ApiError && err.status === 409) {
        if (err.errorKey === 'errors.proposal.notActivated') {
          setInlineErrorKey('proposals.rollback.errorNotActivated');
        } else if (err.errorKey === 'errors.proposal.alreadyDeactivated') {
          setInlineErrorKey('proposals.rollback.errorAlreadyDeactivated');
        } else {
          setInlineErrorKey(err.errorKey);
        }
      } else {
        pushToast({ kind: 'error', message: errorKeyOf(err) });
      }
    } finally {
      setBusy(false);
    }
  }, [layerSlug, proposalId, trimmed, onDone]);

  return (
    <dialog
      ref={ref}
      aria-label={t('proposals.rollback.dialogTitle')}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="rounded-md border bg-background p-4 backdrop:bg-black/50"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex w-96 flex-col gap-3"
      >
        <h2 className="text-base font-semibold">{t('proposals.rollback.dialogTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('proposals.rollback.dialogDescription')}</p>
        <label className="flex flex-col gap-1 text-sm">
          {t('proposals.rollback.reasonLabel')}
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('proposals.rollback.reasonPlaceholder')}
            maxLength={2000}
            rows={4}
            className="rounded-md border bg-background p-2"
            required
            minLength={5}
            aria-describedby="rollback-reason-error"
          />
        </label>
        <p
          id="rollback-reason-error"
          aria-live="polite"
          className={`text-xs ${tooShort ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {tooShort ? t('proposals.rollback.reasonRequired') : ''}
        </p>
        {inlineErrorKey !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {t(inlineErrorKey, { defaultValue: t('errors.network') })}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t('proposals.rollback.cancelCta')}
          </Button>
          <Button type="submit" variant="destructive" disabled={!canSubmit}>
            {busy ? t('common.loading') : t('proposals.rollback.confirmCta')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * Phase 8.4 — collapsed "Auto-activation decision" panel. Reads the
 * stringified JSON from `improvement_proposals.auto_activation_decision_json`,
 * parses + validates with the shared zod schema, then renders the
 * seven gate records as a semantic `<table>` (per plan §9 accessibility:
 * `<th>` for column headers; no `aria-sort` because the table is not
 * user-sortable). Renders a localized alert when parse / validation
 * fails so the gap is visible to admins rather than silently swallowed.
 */
function AutoActivationDecisionPanel({
  decisionJson,
}: {
  readonly decisionJson: string;
}): JSX.Element {
  const { t } = useTranslation();
  let parsed: AutoActivationDecision | null = null;
  let parseFailed = false;
  try {
    const raw = JSON.parse(decisionJson) as unknown;
    const result = AutoActivationDecisionSchema.safeParse(raw);
    if (result.success) parsed = result.data;
    else parseFailed = true;
  } catch {
    parseFailed = true;
  }
  if (parseFailed || parsed === null) {
    return (
      <section aria-labelledby="auto-activation-decision">
        <h2 id="auto-activation-decision" className="text-base font-semibold">
          {t('proposals.autoActivation.decisionTitle')}
        </h2>
        <p role="alert" className="text-sm text-destructive">
          {t('proposals.autoActivation.decisionMalformed')}
        </p>
      </section>
    );
  }
  const decision: AutoActivationDecision = parsed;
  return (
    <section aria-labelledby="auto-activation-decision">
      <h2 id="auto-activation-decision" className="text-base font-semibold">
        {t('proposals.autoActivation.decisionTitle')}
      </h2>
      <details className="mt-2 rounded-md border p-3">
        <summary className="cursor-pointer text-sm">{t('proposals.autoActivation.badge')}</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-1 pr-3">
                  {t('proposals.autoActivation.decisionGateColumn')}
                </th>
                <th scope="col" className="py-1 pr-3">
                  {t('proposals.autoActivation.decisionResultColumn')}
                </th>
                <th scope="col" className="py-1">
                  {t('proposals.autoActivation.decisionDetailColumn')}
                </th>
              </tr>
            </thead>
            <tbody>
              {decision.gates.map((gate, idx) => (
                <tr key={`${gate.name}-${idx}`} className="border-b last:border-0">
                  <td className="py-1 pr-3 font-mono text-xs">{gate.name}</td>
                  <td className="py-1 pr-3">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs uppercase ${
                        gate.passed
                          ? 'border-green-500 text-green-700'
                          : 'border-red-500 text-red-700'
                      }`}
                    >
                      {gate.passed
                        ? t('proposals.autoActivation.decisionGatePassed')
                        : t('proposals.autoActivation.decisionGateFailed')}
                    </span>
                  </td>
                  <td className="py-1">
                    <code className="text-xs">
                      {gate.detail !== undefined ? JSON.stringify(gate.detail) : '—'}
                    </code>
                  </td>
                </tr>
              ))}
              {decision.outcome === 'rejected' ? (
                <tr>
                  <td colSpan={3} className="py-2 text-xs text-destructive">
                    {t('proposals.autoActivation.decisionRejected', { reason: decision.reason })}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function outcomeI18nKey(outcome: string): string {
  switch (outcome) {
    case 'activated-asis':
      return 'proposals.detail.activationOutcomeAsis';
    case 'activated-replanned':
      return 'proposals.detail.activationOutcomeReplanned';
    case 'superseded':
      return 'proposals.detail.supersededOutcome';
    case 'superseded-after-replan':
      return 'proposals.detail.supersededAfterReplanOutcome';
    default:
      return 'proposals.detail.activationOutcomeAsis';
  }
}
