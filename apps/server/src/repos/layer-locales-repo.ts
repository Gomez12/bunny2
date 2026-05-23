import type { Database } from 'bun:sqlite';

/**
 * Persisted per-layer locale row, mirroring `layer_locales` in
 * 0003_layers.sql. Locale-list validation against the system locale
 * list is the route handler's job (3.4); this repo is pure data access.
 */
export interface LayerLocale {
  readonly layerId: string;
  readonly locale: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
}

interface LocaleRow {
  layer_id: string;
  locale: string;
  is_default: number;
  created_at: string;
}

export interface LayerLocalesRepo {
  /**
   * Transactionally replace the layer's locale set. `defaultLocale`, if
   * present, must be one of `locales`; otherwise the function throws.
   * Empty `locales` clears the layer's locale subset (a route may still
   * forbid that — repo level just executes the request).
   */
  setLocales(
    layerId: string,
    locales: readonly string[],
    defaultLocale: string | null,
    now: string,
  ): void;
  listLocales(layerId: string): LayerLocale[];
}

function rowToLocale(row: LocaleRow): LayerLocale {
  return {
    layerId: row.layer_id,
    locale: row.locale,
    isDefault: row.is_default !== 0,
    createdAt: row.created_at,
  };
}

export function createLayerLocalesRepo(db: Database): LayerLocalesRepo {
  const deleteAll = db.query<unknown, [string]>(`DELETE FROM layer_locales WHERE layer_id = ?`);

  const insert = db.query<unknown, [string, string, number, string]>(
    `INSERT INTO layer_locales (layer_id, locale, is_default, created_at)
     VALUES (?, ?, ?, ?)`,
  );

  const list = db.query<LocaleRow, [string]>(
    `SELECT layer_id, locale, is_default, created_at
       FROM layer_locales
      WHERE layer_id = ?
      ORDER BY locale`,
  );

  return {
    setLocales(layerId, locales, defaultLocale, now) {
      if (defaultLocale !== null && !locales.includes(defaultLocale)) {
        throw new Error(`layer-locales-repo: defaultLocale ${defaultLocale} not in locales list`);
      }
      const tx = db.transaction(() => {
        deleteAll.run(layerId);
        for (const locale of locales) {
          insert.run(layerId, locale, locale === defaultLocale ? 1 : 0, now);
        }
      });
      tx();
    },
    listLocales(layerId) {
      return list.all(layerId).map(rowToLocale);
    },
  };
}
