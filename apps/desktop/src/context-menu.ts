import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import { loadTranslator } from './i18n';

/**
 * Electron's runtime exports are loaded lazily inside `installContextMenu`
 * (not at module top-level) so that `buildContextMenuTemplate` and its
 * types can be imported from non-Electron contexts — specifically
 * `apps/desktop/tests/context-menu.test.ts`, which runs under `bun test`.
 * `bun test` does not provide a real Electron runtime; a top-level
 * `import { BrowserWindow, … } from 'electron'` would crash the test
 * loader. Type-only imports are erased at runtime and so are safe.
 */

/**
 * Context-aware right-click menu for the renderer.
 *
 * Electron windows ship without a context menu — without this install
 * users cannot cut/copy/paste, copy a link, or save an image. We mirror
 * the standard Chromium set, no third-party dependency.
 *
 * Labels resolve through the renderer's own i18n catalogue (see
 * `apps/desktop/src/i18n.ts`). Inspect Element is shown only in dev
 * builds so end users do not stumble into devtools.
 *
 * Hard rule: never log `params.selectionText`, `params.linkURL`, or
 * `params.srcURL` — treat them as untrusted user input. Logging only
 * happens at debug points and uses booleans / `mediaType` only.
 */

/** Subset of `ContextMenuParams` the template builder actually reads. */
export interface MenuParamsLike {
  readonly editFlags: {
    readonly canUndo?: boolean;
    readonly canRedo?: boolean;
    readonly canCut?: boolean;
    readonly canCopy?: boolean;
    readonly canPaste?: boolean;
    readonly canDelete?: boolean;
    readonly canSelectAll?: boolean;
  };
  readonly isEditable: boolean;
  readonly selectionText: string;
  readonly linkURL: string;
  readonly srcURL: string;
  readonly mediaType: 'none' | 'image' | 'audio' | 'video' | 'canvas' | 'file' | 'plugin';
  readonly misspelledWord: string;
  readonly dictionarySuggestions: readonly string[];
}

/** Side-effect callbacks the menu items invoke. Injectable for tests. */
export interface MenuActions {
  readonly undo: () => void;
  readonly redo: () => void;
  readonly cut: () => void;
  readonly copy: () => void;
  readonly paste: () => void;
  readonly pasteAndMatchStyle: () => void;
  readonly delete: () => void;
  readonly selectAll: () => void;
  readonly copyLink: (url: string) => void;
  readonly openLinkInBrowser: (url: string) => void;
  readonly copyImage: () => void;
  readonly copyImageAddress: (url: string) => void;
  readonly saveImageAs: () => void;
  readonly addToDictionary: (word: string) => void;
  readonly replaceMisspelling: (word: string) => void;
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly reload: () => void;
  readonly viewPageSource: () => void;
  readonly inspectElement: (x: number, y: number) => void;
}

export interface BuildContextMenuOptions {
  readonly t: (key: string) => string;
  readonly isDev: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly actions: MenuActions;
  /** Position of the right-click; only used by Inspect Element. */
  readonly position?: { x: number; y: number };
}

/**
 * Pure template builder. Given a fake `params` and `opts`, returns the
 * Electron menu template array. Keeping this pure lets the unit tests
 * exercise every branch without spinning up a `BrowserWindow`.
 */
export function buildContextMenuTemplate(
  params: MenuParamsLike,
  opts: BuildContextMenuOptions,
): MenuItemConstructorOptions[] {
  const { t, isDev, canGoBack, canGoForward, actions } = opts;
  const items: MenuItemConstructorOptions[] = [];
  const hasLink = params.linkURL.length > 0;
  const isImage = params.mediaType === 'image';
  const hasSelection = params.selectionText.length > 0;
  const hasMisspelling =
    params.misspelledWord.length > 0 && params.dictionarySuggestions.length >= 0;

  // Spellcheck suggestions go first so they're easy to reach.
  if (hasMisspelling) {
    if (params.dictionarySuggestions.length === 0) {
      items.push({ label: params.misspelledWord, enabled: false });
    } else {
      for (const suggestion of params.dictionarySuggestions) {
        items.push({
          label: suggestion,
          click: () => actions.replaceMisspelling(suggestion),
        });
      }
    }
    items.push({
      label: t('menu.contextMenu.addToDictionary'),
      click: () => actions.addToDictionary(params.misspelledWord),
    });
    items.push({ type: 'separator' });
  }

  // Link context.
  if (hasLink) {
    items.push({
      label: t('menu.contextMenu.openLinkInBrowser'),
      click: () => actions.openLinkInBrowser(params.linkURL),
    });
    items.push({
      label: t('menu.contextMenu.copyLink'),
      click: () => actions.copyLink(params.linkURL),
    });
    items.push({ type: 'separator' });
  }

  // Image context.
  if (isImage) {
    items.push({
      label: t('menu.contextMenu.copyImage'),
      click: () => actions.copyImage(),
    });
    if (params.srcURL.length > 0) {
      items.push({
        label: t('menu.contextMenu.copyImageAddress'),
        click: () => actions.copyImageAddress(params.srcURL),
      });
    }
    items.push({
      label: t('menu.contextMenu.saveImageAs'),
      click: () => actions.saveImageAs(),
    });
    items.push({ type: 'separator' });
  }

  // Editable text controls. The editFlags drive enablement so disabled
  // entries stay visible (more discoverable than hiding them).
  if (params.isEditable) {
    items.push({
      label: t('menu.contextMenu.undo'),
      enabled: params.editFlags.canUndo === true,
      click: () => actions.undo(),
    });
    items.push({
      label: t('menu.contextMenu.redo'),
      enabled: params.editFlags.canRedo === true,
      click: () => actions.redo(),
    });
    items.push({ type: 'separator' });
    items.push({
      label: t('menu.contextMenu.cut'),
      enabled: params.editFlags.canCut === true,
      click: () => actions.cut(),
    });
    items.push({
      label: t('menu.contextMenu.copy'),
      enabled: params.editFlags.canCopy === true,
      click: () => actions.copy(),
    });
    items.push({
      label: t('menu.contextMenu.paste'),
      enabled: params.editFlags.canPaste === true,
      click: () => actions.paste(),
    });
    items.push({
      label: t('menu.contextMenu.pasteAndMatchStyle'),
      enabled: params.editFlags.canPaste === true,
      click: () => actions.pasteAndMatchStyle(),
    });
    items.push({
      label: t('menu.contextMenu.delete'),
      enabled: params.editFlags.canDelete === true,
      click: () => actions.delete(),
    });
    items.push({ type: 'separator' });
    items.push({
      label: t('menu.contextMenu.selectAll'),
      enabled: params.editFlags.canSelectAll === true,
      click: () => actions.selectAll(),
    });
  } else if (hasSelection) {
    // Read-only page with a selection — copy is the only meaningful op.
    items.push({
      label: t('menu.contextMenu.copy'),
      enabled: params.editFlags.canCopy !== false,
      click: () => actions.copy(),
    });
    items.push({
      label: t('menu.contextMenu.selectAll'),
      enabled: params.editFlags.canSelectAll !== false,
      click: () => actions.selectAll(),
    });
  }

  // Navigation items only when nothing more specific applies. Keeps the
  // common right-click-on-text menu tight.
  const showNav = !params.isEditable && !hasLink && !isImage && !hasSelection;
  if (showNav) {
    items.push({
      label: t('menu.contextMenu.back'),
      enabled: canGoBack,
      click: () => actions.goBack(),
    });
    items.push({
      label: t('menu.contextMenu.forward'),
      enabled: canGoForward,
      click: () => actions.goForward(),
    });
    items.push({
      label: t('menu.contextMenu.reload'),
      click: () => actions.reload(),
    });
  }

  // Dev affordances. Inspect Element is the only dev-only entry per the
  // brief — viewPageSource is harmless and shipped in both modes.
  if (items.length > 0) items.push({ type: 'separator' });
  items.push({
    label: t('menu.contextMenu.viewPageSource'),
    click: () => actions.viewPageSource(),
  });
  if (isDev) {
    const pos = opts.position ?? { x: 0, y: 0 };
    items.push({
      label: t('menu.contextMenu.inspectElement'),
      click: () => actions.inspectElement(pos.x, pos.y),
    });
  }

  // Trim a trailing separator (can happen when the only block was nav).
  while (items.length > 0 && items[items.length - 1]?.type === 'separator') {
    items.pop();
  }

  return items;
}

export interface InstallContextMenuOptions {
  readonly isDev: boolean;
  /** Locale hint pushed by the caller; falls back to `BUNNY2_LOCALE` env. */
  readonly localeHint?: string | undefined;
  /** `process.resourcesPath` (packaged) or the desktop repo root (dev). */
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
}

/**
 * Wire the context-menu handler onto a `BrowserWindow`. Safe to call
 * multiple times — Electron replaces a previous listener if you re-add.
 */
export function installContextMenu(win: BrowserWindow, opts: InstallContextMenuOptions): void {
  // Loaded lazily — see the header comment about test-time isolation.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron');
  const { Menu, MenuItem, clipboard, shell } = electron;

  const localeHint = opts.localeHint ?? process.env['BUNNY2_LOCALE'];
  const t = loadTranslator({
    resourcesPath: opts.resourcesPath,
    isPackaged: opts.isPackaged,
    localeHint,
  });

  win.webContents.on('context-menu', (_event, params: ContextMenuParams) => {
    // Debug log: booleans + mediaType only. Never log selectionText,
    // linkURL, or srcURL — they are user input / page content.
    if (opts.isDev) {
      console.log(
        `[bunny2] context-menu editable=${params.isEditable} media=${params.mediaType} hasLink=${params.linkURL.length > 0} hasSelection=${params.selectionText.length > 0}`,
      );
    }

    const wc = win.webContents;
    const actions: MenuActions = {
      undo: () => wc.undo(),
      redo: () => wc.redo(),
      cut: () => wc.cut(),
      copy: () => wc.copy(),
      paste: () => wc.paste(),
      pasteAndMatchStyle: () => wc.pasteAndMatchStyle(),
      delete: () => wc.delete(),
      selectAll: () => wc.selectAll(),
      copyLink: (url) => clipboard.writeText(url),
      openLinkInBrowser: (url) => {
        void shell.openExternal(url);
      },
      copyImage: () => wc.copyImageAt(params.x, params.y),
      copyImageAddress: (url) => clipboard.writeText(url),
      saveImageAs: () => wc.downloadURL(params.srcURL),
      addToDictionary: (word) => wc.session.addWordToSpellCheckerDictionary(word),
      replaceMisspelling: (word) => wc.replaceMisspelling(word),
      goBack: () => {
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      },
      goForward: () => {
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      },
      reload: () => wc.reload(),
      viewPageSource: () => {
        // Open the current URL in DevTools' Sources panel by toggling
        // devtools. We don't ship a separate "view-source:" window —
        // the renderer is a single-page React app and the source view
        // adds little value.
        wc.openDevTools({ mode: 'detach' });
      },
      inspectElement: (x, y) => wc.inspectElement(x, y),
    };

    const template = buildContextMenuTemplate(params, {
      t,
      isDev: opts.isDev,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      actions,
      position: { x: params.x, y: params.y },
    });

    if (template.length === 0) return;
    const menu = Menu.buildFromTemplate(template.map((item) => new MenuItem(item)));
    menu.popup({ window: win });
  });
}
