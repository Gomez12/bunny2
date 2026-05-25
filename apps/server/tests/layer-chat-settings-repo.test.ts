import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../src/storage/sqlite';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createLayerChatSettingsRepo } from '../src/chat/repos/layer-chat-settings-repo';
import {
  createLayerEmbeddingSpendRepo,
  isoDay,
} from '../src/chat/repos/layer-embedding-spend-repo';

/**
 * Per-layer chat settings + embedding-spend round-trip.
 *
 * Mirrors `layer-proposal-settings-repo.test.ts`: fresh temp-dir
 * database per test. The repo carries no clock; tests pass ISO
 * strings directly.
 */

const now = (): string => new Date().toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-layer-chat-settings-'));
  return openDatabase(dir);
}

function seedLayer(db: Database): string {
  const layer = createLayersRepo(db).insertLayer({
    id: crypto.randomUUID(),
    type: 'everyone',
    slug: 'everyone',
    name: 'Everyone',
    now: now(),
  });
  return layer.id;
}

describe('layer-chat-settings-repo', () => {
  it('find returns null when no row exists', () => {
    const db = mkDb();
    try {
      const layerId = seedLayer(db);
      const repo = createLayerChatSettingsRepo(db);
      expect(repo.find(layerId)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('upsert stores then re-reads the override fields', () => {
    const db = mkDb();
    try {
      const layerId = seedLayer(db);
      const repo = createLayerChatSettingsRepo(db);
      const first = repo.upsert({
        layerId,
        model: 'gpt-4o-mini',
        embeddingDailyCap: 1000,
        embeddingMonthlyCap: 20_000,
        now: '2026-05-01T00:00:00.000Z',
      });
      expect(first.model).toBe('gpt-4o-mini');
      expect(first.embeddingDailyCap).toBe(1000);
      expect(first.embeddingMonthlyCap).toBe(20_000);

      // Second upsert overwrites and clears the caps back to NULL.
      const second = repo.upsert({
        layerId,
        model: null,
        embeddingDailyCap: null,
        embeddingMonthlyCap: null,
        now: '2026-05-02T00:00:00.000Z',
      });
      expect(second.model).toBeNull();
      expect(second.embeddingDailyCap).toBeNull();
      expect(second.embeddingMonthlyCap).toBeNull();

      const reloaded = repo.find(layerId);
      expect(reloaded?.model).toBeNull();
      expect(reloaded?.embeddingDailyCap).toBeNull();
    } finally {
      db.close();
    }
  });

  it('rejects a negative daily cap via the SQL CHECK constraint', () => {
    const db = mkDb();
    try {
      const layerId = seedLayer(db);
      const repo = createLayerChatSettingsRepo(db);
      expect(() =>
        repo.upsert({
          layerId,
          model: null,
          embeddingDailyCap: -1,
          embeddingMonthlyCap: null,
          now: now(),
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('layer-embedding-spend-repo', () => {
  it('returns 0 tokens when no spend row exists', () => {
    const db = mkDb();
    try {
      const layerId = seedLayer(db);
      const repo = createLayerEmbeddingSpendRepo(db);
      expect(repo.getDayTokens(layerId, '2026-05-01')).toBe(0);
      expect(repo.sumLastDays(layerId, '2026-05-01', 30)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('addTokens upserts and increments the daily bucket monotonically', () => {
    const db = mkDb();
    try {
      const layerId = seedLayer(db);
      const repo = createLayerEmbeddingSpendRepo(db);
      repo.addTokens(layerId, '2026-05-01', 100);
      repo.addTokens(layerId, '2026-05-01', 50);
      expect(repo.getDayTokens(layerId, '2026-05-01')).toBe(150);
      repo.addTokens(layerId, '2026-05-02', 25);
      expect(repo.getDayTokens(layerId, '2026-05-02')).toBe(25);
    } finally {
      db.close();
    }
  });

  it('sumLastDays adds rows within the rolling window only', () => {
    const db = mkDb();
    try {
      const layerId = seedLayer(db);
      const repo = createLayerEmbeddingSpendRepo(db);
      repo.addTokens(layerId, '2026-05-01', 10);
      repo.addTokens(layerId, '2026-05-15', 20);
      repo.addTokens(layerId, '2026-05-30', 30);
      // Window: 5 days ending 2026-05-30 inclusive — only 2026-05-30 counts.
      expect(repo.sumLastDays(layerId, '2026-05-30', 5)).toBe(30);
      // 16-day window picks up 2026-05-15 + 2026-05-30 = 50.
      expect(repo.sumLastDays(layerId, '2026-05-30', 16)).toBe(50);
      // 30-day window picks up all three rows.
      expect(repo.sumLastDays(layerId, '2026-05-30', 30)).toBe(60);
    } finally {
      db.close();
    }
  });

  it('isoDay returns the YYYY-MM-DD prefix of a Date in UTC', () => {
    expect(isoDay(new Date('2026-05-25T13:45:00.000Z'))).toBe('2026-05-25');
  });
});
