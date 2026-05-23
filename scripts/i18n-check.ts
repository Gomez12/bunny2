#!/usr/bin/env bun
/**
 * i18n discipline check for `apps/web`.
 *
 * Three jobs (per AGENTS.md §i18n + phase-1 plan §8):
 *
 * 1. **No hardcoded user-facing strings.** Scan every `.tsx` under
 *    `apps/web/src/` and flag:
 *      - JSX text nodes that are non-whitespace literal strings.
 *      - User-facing JSX attribute values that are string literals
 *        (`placeholder`, `aria-label`, `title`, `alt`, `label`).
 *    Allowed forms are `t('key')` calls, expressions, JSX, and dynamic
 *    values from props/state.
 *
 * 2. **Every key used by `t('…')` exists in `en.json`.** Static keys only;
 *    dynamic `t(variable)` calls are skipped.
 *
 * 3. **`nl.json` has no unknown keys.** Missing keys in `nl` are OK (the
 *    Dutch locale is a stub) and emitted as warnings, not errors.
 *
 * Uses the TypeScript compiler API so the scan understands the JSX AST
 * instead of regex-matching. `typescript` is already a devDep.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(new URL('.', import.meta.url).pathname, '..');
const webSrc = path.join(repoRoot, 'apps', 'web', 'src');
const enPath = path.join(webSrc, 'i18n', 'locales', 'en.json');
const nlPath = path.join(webSrc, 'i18n', 'locales', 'nl.json');

const userFacingAttributes = new Set([
  'placeholder',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'alt',
  'label',
]);

interface Violation {
  file: string;
  line: number;
  col: number;
  message: string;
}

interface Warning {
  file?: string;
  message: string;
}

const violations: Violation[] = [];
const warnings: Warning[] = [];

const enKeys = collectKeys(readJson(enPath));
const nlKeys = collectKeys(readJson(nlPath));

// 1. Scan all .tsx files.
for (const file of walk(webSrc)) {
  if (!file.endsWith('.tsx')) continue;
  scanFile(file);
}

// 2. Verify referenced keys are present in en.
const usedKeys = collectUsedKeys(webSrc);
for (const { key, file, line } of usedKeys) {
  if (!enKeys.has(key)) {
    violations.push({
      file,
      line,
      col: 1,
      message: `t() key not found in en.json: '${key}'`,
    });
  }
}

// 3. nl unknown keys (warn).
for (const key of nlKeys) {
  if (!enKeys.has(key)) {
    warnings.push({
      file: nlPath,
      message: `nl.json has key not present in en.json: '${key}'`,
    });
  }
}

// 4. nl missing keys (warn, stub locale).
for (const key of enKeys) {
  if (!nlKeys.has(key)) {
    warnings.push({
      file: nlPath,
      message: `nl.json missing key (en has it): '${key}'`,
    });
  }
}

if (warnings.length > 0) {
  console.warn(`[i18n-check] ${warnings.length} warning(s):`);
  for (const w of warnings.slice(0, 20)) {
    console.warn(`  ${w.file ?? ''}: ${w.message}`);
  }
  if (warnings.length > 20) {
    console.warn(`  … and ${warnings.length - 20} more`);
  }
}

if (violations.length > 0) {
  console.error(`[i18n-check] ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.col}  ${v.message}`);
  }
  process.exit(1);
}

console.log(
  `[i18n-check] OK (en keys: ${enKeys.size}, nl keys: ${nlKeys.size}, t() refs: ${usedKeys.length})`,
);

// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function collectKeys(value: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (value === null || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    const next = prefix.length === 0 ? k : `${prefix}.${k}`;
    if (typeof v === 'string') {
      out.add(next);
    } else if (typeof v === 'object' && v !== null) {
      for (const child of collectKeys(v, next)) out.add(child);
    }
  }
  return out;
}

function relativeToRepo(file: string): string {
  return path.relative(repoRoot, file);
}

function scanFile(file: string): void {
  const text = fs.readFileSync(file, 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = relativeToRepo(file);

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const trimmed = node.text.trim();
      if (trimmed.length > 0 && /[A-Za-z]/.test(trimmed)) {
        const { line, character } = src.getLineAndCharacterOfPosition(node.getStart(src));
        violations.push({
          file: rel,
          line: line + 1,
          col: character + 1,
          message: `hardcoded JSX text literal: ${JSON.stringify(trimmed.slice(0, 40))}`,
        });
      }
    }

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(src);
      if (userFacingAttributes.has(name) && node.initializer !== undefined) {
        if (ts.isStringLiteral(node.initializer)) {
          const { line, character } = src.getLineAndCharacterOfPosition(node.getStart(src));
          violations.push({
            file: rel,
            line: line + 1,
            col: character + 1,
            message: `user-facing attribute '${name}' uses a string literal; wrap with t(...)`,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
}

interface KeyRef {
  key: string;
  file: string;
  line: number;
}

function collectUsedKeys(root: string): KeyRef[] {
  const refs: KeyRef[] = [];
  for (const file of walk(root)) {
    if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
    const text = fs.readFileSync(file, 'utf8');
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rel = relativeToRepo(file);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        // Match `t('…')` — bare identifier `t`. Other call shapes
        // (`i18n.t`, `useT()`) are intentionally not in scope here; phase
        // 1.5 only uses `useTranslation().t`.
        if (ts.isIdentifier(callee) && callee.text === 't') {
          const first = node.arguments[0];
          if (first !== undefined && ts.isStringLiteral(first)) {
            const { line } = src.getLineAndCharacterOfPosition(first.getStart(src));
            refs.push({ key: first.text, file: rel, line: line + 1 });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(src, visit);
  }
  return refs;
}
