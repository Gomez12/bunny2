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
import { useCurrentLayer } from '../lib/use-current-layer';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';
import {
  approveLayerProposal,
  rejectLayerProposal,
  replayProposalSandbox,
  type ProposalArtifactItem,
  type ProposalDetailResponse,
  type ProposalEvidenceItem,
} from '../lib/api';
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

  useMemo(() => {
    if (layerSlug === null) return;
    console.log('[chat.analytics] proposal_detail_opened', { layerSlug, proposalId });
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
    </div>
  );
}

function ProposalDetailView({
  data,
  layerSlug,
  canEdit,
  onChange,
  onOpenReject,
}: {
  readonly data: ProposalDetailResponse;
  readonly layerSlug: string;
  readonly canEdit: boolean;
  readonly onChange: () => void;
  readonly onOpenReject: () => void;
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
      console.log('[chat.analytics] proposal_approved', {
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
      console.log('[chat.analytics] proposal_sandbox_replayed', {
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
        </div>
      </CardContent>
    </Card>
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
      console.log('[chat.analytics] proposal_rejected', {
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
