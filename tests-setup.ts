/**
 * `bun test` preload. Runs once before any test file.
 *
 * Forces SQLite into `journal_mode = DELETE` so that no `-wal`/`-shm`
 * sidecar files are created. `bun:sqlite` on Windows holds those
 * files open after `db.close()`, which makes `fs.rmSync` of the
 * temp data-dir fail with EBUSY (see CI run 26338226439). Production
 * is unaffected; only `openDatabase` callers in tests pick this up.
 */
process.env['BUNNY2_SQLITE_JOURNAL_MODE'] ??= 'DELETE';
