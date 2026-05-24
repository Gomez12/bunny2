import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../src/storage/sqlite';
import { createUsersRepo } from '../src/repos/users-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import {
  LAYER_PROPOSAL_SETTINGS_DEFAULTS,
  LayerProposalSettingsRepo,
} from '../src/proposals/repos/layer-proposal-settings-repo';

/**
 * Phase 8.1 — `layer_proposal_settings` repo round-trip.
 *
 * Mirrors the harness style of `proposals-repo.test.ts`: a fresh
 * temp-dir Database per test (so `openDatabase` runs the migrations
 * from disk against an empty file). The CHECK-constraint failures
 * surface as thrown errors from `bun:sqlite`; we assert via
 * `.toThrow()` rather than introspecting the constraint name, to
 * keep the assertion portable across SQLite versions.
 */

const now = () => new Date().toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-layer-proposal-settings-'));
  return openDatabase(dir);
}

interface Seeded {
  userId: string;
  layerId: string;
}

function seedLayerAndUser(db: Database): Seeded {
  const user = createUsersRepo(db).createUser({
    id: crypto.randomUUID(),
    username: 'admin',
    displayName: 'Admin',
    passwordHash: 'h',
    mustChangePassword: false,
    now: now(),
  });
  const layer = createLayersRepo(db).insertLayer({
    id: crypto.randomUUID(),
    type: 'everyone',
    slug: 'everyone',
    name: 'Everyone',
    now: now(),
  });
  return { userId: user.id, layerId: layer.id };
}

describe('layer-proposal-settings-repo', () => {
  it('find returns null when no row exists for the layer', () => {
    const db = mkDb();
    try {
      const { layerId } = seedLayerAndUser(db);
      const repo = new LayerProposalSettingsRepo(db);
      expect(repo.find(layerId)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('getOrDefault returns the resolved defaults when no row exists', () => {
    const db = mkDb();
    try {
      const { layerId } = seedLayerAndUser(db);
      const repo = new LayerProposalSettingsRepo(db);
      const settings = repo.getOrDefault(layerId);
      expect(settings.layerId).toBe(layerId);
      expect(settings.autoActivationEnabled).toBe(
        LAYER_PROPOSAL_SETTINGS_DEFAULTS.autoActivationEnabled,
      );
      expect(settings.thresholdCutoff).toBe(LAYER_PROPOSAL_SETTINGS_DEFAULTS.thresholdCutoff);
      expect(settings.cooldownHours).toBe(LAYER_PROPOSAL_SETTINGS_DEFAULTS.cooldownHours);
      expect(settings.requireThumbsUpDeltaPositive).toBe(
        LAYER_PROPOSAL_SETTINGS_DEFAULTS.requireThumbsUpDeltaPositive,
      );
      expect(settings.maxTokensDelta).toBe(LAYER_PROPOSAL_SETTINGS_DEFAULTS.maxTokensDelta);
      // The default object carries empty audit strings so callers
      // can distinguish "synthesized defaults" from "real row".
      expect(settings.updatedAt).toBe('');
      expect(settings.updatedBy).toBe('');
    } finally {
      db.close();
    }
  });

  it('upsert inserts the first time and updates the second time for the same layer', () => {
    const db = mkDb();
    try {
      const { layerId, userId } = seedLayerAndUser(db);
      const repo = new LayerProposalSettingsRepo(db);
      const first = repo.upsert({
        layerId,
        autoActivationEnabled: true,
        thresholdCutoff: 0.5,
        cooldownHours: 12,
        requireThumbsUpDeltaPositive: true,
        maxTokensDelta: null,
        updatedBy: userId,
        now: '2026-05-01T00:00:00.000Z',
      });
      expect(first.autoActivationEnabled).toBe(true);
      expect(first.thresholdCutoff).toBe(0.5);
      expect(first.cooldownHours).toBe(12);
      expect(first.maxTokensDelta).toBeNull();
      expect(first.updatedAt).toBe('2026-05-01T00:00:00.000Z');
      expect(first.updatedBy).toBe(userId);

      const second = repo.upsert({
        layerId,
        autoActivationEnabled: false,
        thresholdCutoff: 0.8,
        cooldownHours: 48,
        requireThumbsUpDeltaPositive: false,
        maxTokensDelta: 200,
        updatedBy: userId,
        now: '2026-05-02T00:00:00.000Z',
      });
      expect(second.autoActivationEnabled).toBe(false);
      expect(second.thresholdCutoff).toBe(0.8);
      expect(second.cooldownHours).toBe(48);
      expect(second.requireThumbsUpDeltaPositive).toBe(false);
      expect(second.maxTokensDelta).toBe(200);
      expect(second.updatedAt).toBe('2026-05-02T00:00:00.000Z');

      // After upsert, `find` returns the real row, not the defaults.
      const reloaded = repo.find(layerId);
      expect(reloaded?.thresholdCutoff).toBe(0.8);
      expect(reloaded?.maxTokensDelta).toBe(200);
    } finally {
      db.close();
    }
  });

  it('rejects threshold_cutoff outside [0, 1] via the SQL CHECK constraint', () => {
    const db = mkDb();
    try {
      const { layerId, userId } = seedLayerAndUser(db);
      const repo = new LayerProposalSettingsRepo(db);
      expect(() =>
        repo.upsert({
          layerId,
          autoActivationEnabled: false,
          thresholdCutoff: 1.5,
          cooldownHours: 24,
          requireThumbsUpDeltaPositive: true,
          maxTokensDelta: null,
          updatedBy: userId,
          now: now(),
        }),
      ).toThrow();
      expect(() =>
        repo.upsert({
          layerId,
          autoActivationEnabled: false,
          thresholdCutoff: -0.01,
          cooldownHours: 24,
          requireThumbsUpDeltaPositive: true,
          maxTokensDelta: null,
          updatedBy: userId,
          now: now(),
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects cooldown_hours outside [0, 720] via the SQL CHECK constraint', () => {
    const db = mkDb();
    try {
      const { layerId, userId } = seedLayerAndUser(db);
      const repo = new LayerProposalSettingsRepo(db);
      expect(() =>
        repo.upsert({
          layerId,
          autoActivationEnabled: false,
          thresholdCutoff: 0.5,
          cooldownHours: -1,
          requireThumbsUpDeltaPositive: true,
          maxTokensDelta: null,
          updatedBy: userId,
          now: now(),
        }),
      ).toThrow();
      expect(() =>
        repo.upsert({
          layerId,
          autoActivationEnabled: false,
          thresholdCutoff: 0.5,
          cooldownHours: 721,
          requireThumbsUpDeltaPositive: true,
          maxTokensDelta: null,
          updatedBy: userId,
          now: now(),
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects max_tokens_delta = -1 via the SQL CHECK constraint when not null', () => {
    const db = mkDb();
    try {
      const { layerId, userId } = seedLayerAndUser(db);
      const repo = new LayerProposalSettingsRepo(db);
      expect(() =>
        repo.upsert({
          layerId,
          autoActivationEnabled: false,
          thresholdCutoff: 0.5,
          cooldownHours: 24,
          requireThumbsUpDeltaPositive: true,
          maxTokensDelta: -1,
          updatedBy: userId,
          now: now(),
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects a layer_id that does not exist in layers via the FK constraint', () => {
    const db = mkDb();
    try {
      const { userId } = seedLayerAndUser(db);
      const repo = new LayerProposalSettingsRepo(db);
      expect(() =>
        repo.upsert({
          layerId: crypto.randomUUID(),
          autoActivationEnabled: false,
          thresholdCutoff: 0.5,
          cooldownHours: 24,
          requireThumbsUpDeltaPositive: true,
          maxTokensDelta: null,
          updatedBy: userId,
          now: now(),
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
