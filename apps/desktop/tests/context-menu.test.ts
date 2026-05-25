import { describe, expect, it } from 'bun:test';
import {
  buildContextMenuTemplate,
  type MenuActions,
  type MenuParamsLike,
} from '../src/context-menu';

/**
 * Pure-template tests. We never instantiate a `BrowserWindow`; every
 * Electron side-effect is captured via the injected `actions` map.
 */

const NOOP: MenuActions = {
  undo: () => undefined,
  redo: () => undefined,
  cut: () => undefined,
  copy: () => undefined,
  paste: () => undefined,
  pasteAndMatchStyle: () => undefined,
  delete: () => undefined,
  selectAll: () => undefined,
  copyLink: () => undefined,
  openLinkInBrowser: () => undefined,
  copyImage: () => undefined,
  copyImageAddress: () => undefined,
  saveImageAs: () => undefined,
  addToDictionary: () => undefined,
  replaceMisspelling: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  reload: () => undefined,
  viewPageSource: () => undefined,
  inspectElement: () => undefined,
};

function t(key: string): string {
  // Identity translator — surfaces the raw key in the label so the
  // tests assert against the keys directly.
  return key;
}

function makeParams(overrides: Partial<MenuParamsLike> = {}): MenuParamsLike {
  return {
    editFlags: {},
    isEditable: false,
    selectionText: '',
    linkURL: '',
    srcURL: '',
    mediaType: 'none',
    misspelledWord: '',
    dictionarySuggestions: [],
    ...overrides,
  };
}

function labels(items: ReadonlyArray<{ label?: string; type?: string }>): string[] {
  return items.map((i) => (i.type === 'separator' ? '---' : (i.label ?? '')));
}

describe('buildContextMenuTemplate — editable text', () => {
  it('renders the edit cluster with enablement driven by editFlags', () => {
    const params = makeParams({
      isEditable: true,
      editFlags: {
        canUndo: true,
        canRedo: false,
        canCut: true,
        canCopy: true,
        canPaste: false,
        canDelete: true,
        canSelectAll: true,
      },
    });
    const items = buildContextMenuTemplate(params, {
      t,
      isDev: false,
      canGoBack: false,
      canGoForward: false,
      actions: NOOP,
    });
    const ls = labels(items);
    expect(ls).toContain('menu.contextMenu.cut');
    expect(ls).toContain('menu.contextMenu.copy');
    expect(ls).toContain('menu.contextMenu.paste');
    expect(ls).toContain('menu.contextMenu.pasteAndMatchStyle');
    expect(ls).toContain('menu.contextMenu.delete');
    expect(ls).toContain('menu.contextMenu.selectAll');
    expect(ls).toContain('menu.contextMenu.undo');
    expect(ls).toContain('menu.contextMenu.redo');

    const paste = items.find((i) => i.label === 'menu.contextMenu.paste');
    expect(paste?.enabled).toBe(false);
    const cut = items.find((i) => i.label === 'menu.contextMenu.cut');
    expect(cut?.enabled).toBe(true);
    const redo = items.find((i) => i.label === 'menu.contextMenu.redo');
    expect(redo?.enabled).toBe(false);
  });

  it('hides nav items when the target is editable', () => {
    const params = makeParams({ isEditable: true, editFlags: { canPaste: true } });
    const items = buildContextMenuTemplate(params, {
      t,
      isDev: false,
      canGoBack: true,
      canGoForward: true,
      actions: NOOP,
    });
    const ls = labels(items);
    expect(ls).not.toContain('menu.contextMenu.back');
    expect(ls).not.toContain('menu.contextMenu.forward');
    expect(ls).not.toContain('menu.contextMenu.reload');
  });
});

describe('buildContextMenuTemplate — selection on read-only page', () => {
  it('offers copy and selectAll only', () => {
    const params = makeParams({ selectionText: 'hello' });
    const items = buildContextMenuTemplate(params, {
      t,
      isDev: false,
      canGoBack: false,
      canGoForward: false,
      actions: NOOP,
    });
    const ls = labels(items);
    expect(ls).toContain('menu.contextMenu.copy');
    expect(ls).toContain('menu.contextMenu.selectAll');
    expect(ls).not.toContain('menu.contextMenu.cut');
    expect(ls).not.toContain('menu.contextMenu.paste');
    expect(ls).not.toContain('menu.contextMenu.back');
  });
});

describe('buildContextMenuTemplate — link context', () => {
  it('shows open-in-browser and copy-link', () => {
    const params = makeParams({ linkURL: 'https://example.com/foo' });
    const items = buildContextMenuTemplate(params, {
      t,
      isDev: false,
      canGoBack: false,
      canGoForward: false,
      actions: NOOP,
    });
    const ls = labels(items);
    expect(ls).toContain('menu.contextMenu.openLinkInBrowser');
    expect(ls).toContain('menu.contextMenu.copyLink');
    // Link context suppresses navigation items.
    expect(ls).not.toContain('menu.contextMenu.back');
  });
});

describe('buildContextMenuTemplate — image context', () => {
  it('shows copyImage, copyImageAddress, and saveImageAs', () => {
    const params = makeParams({ mediaType: 'image', srcURL: 'https://x/y.png' });
    const items = buildContextMenuTemplate(params, {
      t,
      isDev: false,
      canGoBack: false,
      canGoForward: false,
      actions: NOOP,
    });
    const ls = labels(items);
    expect(ls).toContain('menu.contextMenu.copyImage');
    expect(ls).toContain('menu.contextMenu.copyImageAddress');
    expect(ls).toContain('menu.contextMenu.saveImageAs');
  });

  it('omits copyImageAddress when srcURL is empty', () => {
    const params = makeParams({ mediaType: 'image', srcURL: '' });
    const items = buildContextMenuTemplate(params, {
      t,
      isDev: false,
      canGoBack: false,
      canGoForward: false,
      actions: NOOP,
    });
    const ls = labels(items);
    expect(ls).toContain('menu.contextMenu.copyImage');
    expect(ls).not.toContain('menu.contextMenu.copyImageAddress');
  });
});

describe('buildContextMenuTemplate — spellcheck', () => {
  it('lists each suggestion plus addToDictionary', () => {
    const replaced: string[] = [];
    const added: string[] = [];
    const actions: MenuActions = {
      ...NOOP,
      replaceMisspelling: (w) => replaced.push(w),
      addToDictionary: (w) => added.push(w),
    };
    const params = makeParams({
      isEditable: true,
      editFlags: { canCopy: true, canPaste: true },
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'tech'],
    });
    const items = buildContextMenuTemplate(params, {
      t,
      isDev: false,
      canGoBack: false,
      canGoForward: false,
      actions,
    });
    const ls = labels(items);
    expect(ls).toContain('the');
    expect(ls).toContain('tech');
    expect(ls).toContain('menu.contextMenu.addToDictionary');

    // Invoking the suggestion click triggers replace.
    type ClickItem = { label?: string; click?: () => void };
    const sug = items.find((i): i is ClickItem => (i as ClickItem).label === 'the');
    sug?.click?.();
    expect(replaced).toEqual(['the']);

    const add = items.find(
      (i): i is ClickItem => (i as ClickItem).label === 'menu.contextMenu.addToDictionary',
    );
    add?.click?.();
    expect(added).toEqual(['teh']);
  });

  it('disables a noop entry when there are no suggestions', () => {
    const params = makeParams({
      isEditable: true,
      editFlags: { canCopy: true, canPaste: true },
      misspelledWord: 'qwxz',
      dictionarySuggestions: [],
    });
    const items = buildContextMenuTemplate(params, {
      t,
      isDev: false,
      canGoBack: false,
      canGoForward: false,
      actions: NOOP,
    });
    const placeholder = items.find((i) => i.label === 'qwxz');
    expect(placeholder?.enabled).toBe(false);
  });
});

describe('buildContextMenuTemplate — dev vs packaged', () => {
  it('includes Inspect Element only when isDev is true', () => {
    const params = makeParams();
    const dev = buildContextMenuTemplate(params, {
      t,
      isDev: true,
      canGoBack: false,
      canGoForward: false,
      actions: NOOP,
    });
    const prod = buildContextMenuTemplate(params, {
      t,
      isDev: false,
      canGoBack: false,
      canGoForward: false,
      actions: NOOP,
    });
    expect(labels(dev)).toContain('menu.contextMenu.inspectElement');
    expect(labels(prod)).not.toContain('menu.contextMenu.inspectElement');
  });

  it('uses the position from opts for Inspect Element', () => {
    const captured: { value: { x: number; y: number } | null } = { value: null };
    const actions: MenuActions = {
      ...NOOP,
      inspectElement: (x, y) => {
        captured.value = { x, y };
      },
    };
    const params = makeParams();
    const items = buildContextMenuTemplate(params, {
      t,
      isDev: true,
      canGoBack: false,
      canGoForward: false,
      actions,
      position: { x: 42, y: 7 },
    });
    type ClickItem = { label?: string; click?: () => void };
    const inspect = items.find(
      (i): i is ClickItem => (i as ClickItem).label === 'menu.contextMenu.inspectElement',
    );
    inspect?.click?.();
    expect(captured.value).toEqual({ x: 42, y: 7 });
  });
});

describe('buildContextMenuTemplate — navigation', () => {
  it('shows back/forward/reload on a plain page click', () => {
    const params = makeParams();
    const items = buildContextMenuTemplate(params, {
      t,
      isDev: false,
      canGoBack: true,
      canGoForward: false,
      actions: NOOP,
    });
    const ls = labels(items);
    expect(ls).toContain('menu.contextMenu.back');
    expect(ls).toContain('menu.contextMenu.forward');
    expect(ls).toContain('menu.contextMenu.reload');
    expect(items.find((i) => i.label === 'menu.contextMenu.back')?.enabled).toBe(true);
    expect(items.find((i) => i.label === 'menu.contextMenu.forward')?.enabled).toBe(false);
  });

  it('always offers View Page Source', () => {
    const params = makeParams();
    const items = buildContextMenuTemplate(params, {
      t,
      isDev: false,
      canGoBack: false,
      canGoForward: false,
      actions: NOOP,
    });
    expect(labels(items)).toContain('menu.contextMenu.viewPageSource');
  });
});
