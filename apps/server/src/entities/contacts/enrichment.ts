import type { CompanyPayload, ContactPayload, EntitySummary } from '@bunny2/shared';
import type { Entity } from '@bunny2/shared';
import type { ChatMessage } from '../../llm';
import { createEntityStore } from '../store';
import { getEntityModule } from '../registry';
import type { EntityModule } from '../module';
import type { EnrichmentJob, EnrichmentJobContext, EnrichmentResult } from '../module';

/**
 * Phase 4b.3 — contacts AI enrichment.
 *
 * One job ships in 4b.3:
 *
 *  - `contacts.suggestCompany` (runs on created / updated / sync.succeeded)
 *    proposes a `payload.companyEntityId` link to a company in the same
 *    layer. The strategy is deterministic-first, LLM-fallback:
 *
 *      1. **Domain match**. If the contact has a primary email, take its
 *         domain (normalising the `www.` prefix). For each company in the
 *         same layer, compare against the company's website host and
 *         email domain. An exact match is "confident"; the runner applies
 *         the link without any LLM call. No competing candidate may
 *         exist — when two companies match the same domain (an exotic
 *         case) the job defers to the LLM step instead of guessing.
 *
 *      2. **vCard ORG hint**. The 4b.2 vCard parser stamps an
 *         `ORG: <name>` line into `payload.notes`. Parse it; for each
 *         company, compare the hint against `legalName`, `tradeName`,
 *         and `title` (case-insensitive, whitespace-normalised). An
 *         exact match is "confident"; a fuzzy-but-close match
 *         (Levenshtein ≤ 2 over normalised strings) goes to the LLM
 *         step. When 1+ exact match exists, the job picks that one and
 *         skips the LLM.
 *
 *      3. **LLM fallback**. Only when 1 and 2 yielded a non-empty set of
 *         weak candidates does the job ask the LLM. The prompt carries
 *         the contact's `(givenName, familyName, primary email,
 *         jobTitle, notes excerpt)` and a sanitised list of candidate
 *         companies (`slug`, `title`, `website`). The model returns a
 *         JSON object `{ slug, confidence }` where `confidence ∈ [0, 1]`
 *         and `slug = "none"` signals "no match". The job applies the
 *         link only when `confidence >= 0.8` and the slug resolves to a
 *         candidate. Anything else returns `{}`.
 *
 * The job is gated by `payload.companyEntityId == null` — once a user
 * (or a previous run) has stamped a link, the job returns `{}` without
 * any matching work. This is defense in depth: the runner's
 * `applyPatch` would also refuse to overwrite a non-empty user field,
 * but the explicit gate avoids burning candidates / LLM tokens.
 *
 * Secrets discipline: the candidate-list projection drops every field
 * except `slug`, `title`, `website`. The connector apiKey lives in
 * `layer_attachments.config` and never reaches a company payload —
 * verified by the secret-strip test that mirrors 4a.3.
 */

const ORG_HINT_RE = /^ORG:\s*(.+?)\s*$/im;
const CONFIDENCE_THRESHOLD = 0.8;
const FUZZY_DISTANCE = 2;
const NOTES_EXCERPT_MAX = 400;

interface ContactCandidate {
  readonly entity: Entity<CompanyPayload>;
  /** A short reason useful for prompt-time debugging. Not persisted. */
  readonly reason: string;
}

export const contactsSuggestCompanyJob: EnrichmentJob<ContactPayload> = {
  id: 'contacts.suggestCompany',
  runOn: ['created', 'updated', 'sync.succeeded'],
  async run(
    contact: Entity<ContactPayload>,
    ctx: EnrichmentJobContext<ContactPayload>,
  ): Promise<EnrichmentResult<ContactPayload>> {
    // No-overwrite invariant: the runner would also refuse to stomp on a
    // user-set field (see `applyPatch` in `enrichment-runner.ts`), but
    // gating up-front avoids burning candidates + LLM tokens.
    if (
      contact.payload.companyEntityId !== undefined &&
      contact.payload.companyEntityId !== null &&
      contact.payload.companyEntityId !== ''
    ) {
      return {};
    }

    const companies = listCompaniesInLayer(ctx);
    if (companies.length === 0) {
      // Cross-layer isolation: no candidates means no link and no LLM
      // call. The test relies on this branch.
      return {};
    }

    const email = primaryEmailOf(contact.payload);
    const orgHint = readOrgHint(contact.payload.notes);

    // ---- Deterministic step 1: domain match ----------------------------
    if (email !== null) {
      const contactDomain = domainOf(email);
      if (contactDomain !== null) {
        const domainMatches = companies.filter((c) => companyMatchesDomain(c, contactDomain));
        if (domainMatches.length === 1) {
          const sole = domainMatches[0];
          if (sole !== undefined) {
            return { patch: { companyEntityId: sole.id } as Partial<ContactPayload> };
          }
        }
        // 0 matches → keep going. >1 → ambiguous, fall through to LLM
        // with the matches as the candidate set.
        if (domainMatches.length > 1) {
          return askLlm(contact, ctx, email, orgHint, toCandidates(domainMatches, 'domain'));
        }
      }
    }

    // ---- Deterministic step 2: ORG hint --------------------------------
    if (orgHint !== null) {
      const exact = companies.filter((c) => orgExactMatch(c, orgHint));
      if (exact.length === 1) {
        const sole = exact[0];
        if (sole !== undefined) {
          return { patch: { companyEntityId: sole.id } as Partial<ContactPayload> };
        }
      }
      if (exact.length > 1) {
        return askLlm(contact, ctx, email, orgHint, toCandidates(exact, 'org-exact'));
      }
      // Fuzzy fallback only when no exact match exists.
      const fuzzy = companies.filter((c) => orgFuzzyMatch(c, orgHint));
      if (fuzzy.length > 0) {
        return askLlm(contact, ctx, email, orgHint, toCandidates(fuzzy, 'org-fuzzy'));
      }
    }

    // No deterministic candidates, no fuzzy hits → no link, no LLM.
    return {};
  },
};

export const contactEnrichmentJobs: readonly EnrichmentJob<ContactPayload>[] = [
  contactsSuggestCompanyJob,
];

// ---------------------------------------------------------------------------
// LLM fallback
// ---------------------------------------------------------------------------

async function askLlm(
  contact: Entity<ContactPayload>,
  ctx: EnrichmentJobContext<ContactPayload>,
  email: string | null,
  orgHint: string | null,
  candidates: readonly ContactCandidate[],
): Promise<EnrichmentResult<ContactPayload>> {
  if (candidates.length === 0) {
    return {};
  }
  const messages = buildSuggestionMessages(contact, email, orgHint, candidates);
  const response = await ctx.llm.chat({
    messages,
    metadata: {
      layerId: ctx.layerId,
      ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
      flowId: 'enrichment:contacts.suggestCompany',
    },
  });
  const parsed = safeParseJson(response.content);
  const result: EnrichmentResult<ContactPayload> = {
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    model: response.model,
  };
  if (parsed === null || typeof parsed !== 'object') {
    return result;
  }
  const obj = parsed as Record<string, unknown>;
  const slug = typeof obj.slug === 'string' ? obj.slug.trim() : '';
  const confidence = typeof obj.confidence === 'number' ? obj.confidence : 0;
  if (slug === '' || slug.toLowerCase() === 'none') {
    return result;
  }
  if (!Number.isFinite(confidence) || confidence < CONFIDENCE_THRESHOLD) {
    return result;
  }
  const pick = candidates.find((c) => c.entity.slug === slug);
  if (pick === undefined) {
    return result;
  }
  return {
    ...result,
    patch: { companyEntityId: pick.entity.id } as Partial<ContactPayload>,
  };
}

function buildSuggestionMessages(
  contact: Entity<ContactPayload>,
  email: string | null,
  orgHint: string | null,
  candidates: readonly ContactCandidate[],
): readonly ChatMessage[] {
  // Project the contact to the minimum useful surface. Strip everything
  // else so the prompt size and the secret-strip surface both stay tiny.
  const contactView = {
    givenName: contact.payload.givenName ?? null,
    familyName: contact.payload.familyName ?? null,
    displayName: contact.payload.displayName ?? null,
    primaryEmail: email,
    jobTitle: contact.payload.jobTitle ?? null,
    orgHint,
    notesExcerpt: excerptNotes(contact.payload.notes ?? null),
  };
  // Sanitise the candidate list: slug + title + website only. No external
  // link payloads, no addresses, no email/phone, no description.
  const candidateView = candidates.map((c) => ({
    slug: c.entity.slug,
    title: c.entity.title,
    website: c.entity.payload.website ?? null,
  }));
  const sys: ChatMessage = {
    role: 'system',
    content:
      'You match a contact to one company from a candidate list. ' +
      'Return ONLY a JSON object with keys "slug" and "confidence". ' +
      '"slug" is one of the candidate slugs or the literal string "none". ' +
      '"confidence" is a number between 0 and 1. ' +
      'Be conservative: prefer "none" with confidence 0.0 when uncertain.',
  };
  const user: ChatMessage = {
    role: 'user',
    content: [
      `Contact: ${JSON.stringify(contactView)}`,
      `Candidates: ${JSON.stringify(candidateView)}`,
      'Return the JSON.',
    ].join('\n'),
  };
  return [sys, user];
}

// ---------------------------------------------------------------------------
// Candidate enumeration
// ---------------------------------------------------------------------------

/**
 * Enumerate non-deleted companies in the contact's layer.
 *
 * We deliberately build a one-shot companies-`EntityStore` from the
 * registry instead of caching anything: the runner already debounces
 * per `(kind, entityId)`, and the per-call cost is dominated by the
 * downstream LLM call anyway. Keeps the job stateless.
 *
 * `getEntityModule('company')` is the registry lookup; the job returns
 * `[]` when the module is not registered (e.g. companies-disabled
 * test fixture). The cross-layer isolation test relies on this — a
 * layer with zero companies returns `[]` and the job exits early.
 */
function listCompaniesInLayer(
  ctx: EnrichmentJobContext<ContactPayload>,
): readonly Entity<CompanyPayload>[] {
  const companyModule = getEntityModule('company') as EntityModule<CompanyPayload> | null;
  if (companyModule === null) return [];
  const store = createEntityStore<CompanyPayload>({
    module: companyModule,
    db: ctx.db,
    bus: ctx.bus,
    llm: ctx.llm,
  });
  const summaries: readonly EntitySummary[] = store.listSummaries([ctx.layerId], {
    limit: 200,
  });
  const result: Entity<CompanyPayload>[] = [];
  for (const s of summaries) {
    const entity = store.getById(s.id);
    if (entity === null) continue;
    if (entity.meta.deletedAt !== null) continue;
    result.push(entity);
  }
  return result;
}

function toCandidates(
  matches: readonly Entity<CompanyPayload>[],
  reason: string,
): readonly ContactCandidate[] {
  return matches.map((entity) => ({ entity, reason }));
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function primaryEmailOf(payload: ContactPayload): string | null {
  const emails = payload.emails;
  if (emails === undefined || emails.length === 0) return null;
  const primary = emails.find((e) => e.isPrimary === true);
  return primary?.value ?? emails[0]?.value ?? null;
}

function readOrgHint(notes: string | undefined): string | null {
  if (notes === undefined || notes.trim().length === 0) return null;
  const m = ORG_HINT_RE.exec(notes);
  if (m === null) return null;
  const hint = (m[1] ?? '').trim();
  return hint.length === 0 ? null : hint;
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  const raw = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (raw === '') return null;
  return raw.startsWith('www.') ? raw.slice(4) : raw;
}

function companyMatchesDomain(company: Entity<CompanyPayload>, contactDomain: string): boolean {
  const websiteHost = hostOfUrl(company.payload.website ?? null);
  if (websiteHost !== null && websiteHost === contactDomain) return true;
  const emailDomain = domainOf(company.payload.email ?? '');
  if (emailDomain !== null && emailDomain === contactDomain) return true;
  return false;
}

function hostOfUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function companyNameCandidates(company: Entity<CompanyPayload>): readonly string[] {
  const out: string[] = [];
  const push = (v: string | undefined | null): void => {
    if (v === undefined || v === null) return;
    const n = normaliseName(v);
    if (n.length > 0) out.push(n);
  };
  push(company.payload.legalName);
  push(company.payload.tradeName);
  push(company.title);
  return out;
}

function orgExactMatch(company: Entity<CompanyPayload>, orgHint: string): boolean {
  const needle = normaliseName(orgHint);
  if (needle === '') return false;
  for (const n of companyNameCandidates(company)) {
    if (n === needle) return true;
  }
  return false;
}

function orgFuzzyMatch(company: Entity<CompanyPayload>, orgHint: string): boolean {
  const needle = normaliseName(orgHint);
  if (needle === '') return false;
  for (const n of companyNameCandidates(company)) {
    if (n === needle) return true;
    if (levenshtein(n, needle) <= FUZZY_DISTANCE) return true;
  }
  return false;
}

/**
 * Small two-row Levenshtein. Bounded inputs (company names ≤ 200 chars,
 * the hint capped by the notes field) keep this O(n·m) cheap.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n] ?? 0;
}

function excerptNotes(notes: string | null): string | null {
  if (notes === null) return null;
  const trimmed = notes.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= NOTES_EXCERPT_MAX) return trimmed;
  return `${trimmed.slice(0, NOTES_EXCERPT_MAX - 1).trimEnd()}…`;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced !== null && fenced[1] !== undefined) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
