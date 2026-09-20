/**
 * Click-point context menu for the camera backend: a small button strip that
 * pops up where the user clicked an object (or where click-to-detect just
 * registered one) with the edits that apply to it. Pure DOM; the app supplies
 * the actions and the labels are derived from the object's state.
 */
import type { EditableObject } from '@/core/types';

export interface ContextMenuActions {
  move(objectId: string): void;
  delete(objectId: string): void;
  restore(objectId: string): void;
  capturePlate(objectId: string): void;
  undo(): void;
}

export interface ContextMenuItem {
  label: string;
  action: () => void;
  /** Greyed out with this explanation when the edit is not available. */
  disabledReason?: string;
}

/** Which buttons an object gets, from its state and tier. Exported for tests. */
export function menuItemsFor(obj: EditableObject, actions: ContextMenuActions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const tierAllows = (edit: 'move' | 'delete'): boolean => {
    if (obj.origin !== 'physical') return true;
    if (edit === 'move') return obj.tier !== 'E';
    return obj.tier === 'A' || obj.tier === 'B';
  };
  if (obj.visible) {
    items.push(
      tierAllows('move')
        ? { label: 'Move', action: () => actions.move(obj.id) }
        : { label: 'Move', action: () => undefined, disabledReason: 'not enough evidence yet (tier E)' },
    );
    items.push(
      tierAllows('delete')
        ? { label: 'Delete', action: () => actions.delete(obj.id) }
        : { label: 'Delete', action: () => undefined, disabledReason: 'needs a background: Capture plate first' },
    );
    if (obj.origin === 'physical') items.push({ label: 'Capture plate', action: () => actions.capturePlate(obj.id) });
  } else {
    items.push({ label: 'Restore', action: () => actions.restore(obj.id) });
  }
  items.push({ label: 'Undo', action: () => actions.undo() });
  return items;
}

export class ContextMenu {
  readonly root: HTMLDivElement;
  private objectId: string | null = null;
  private readonly onDocPointerDown = (e: PointerEvent): void => {
    if (!this.root.contains(e.target as Node)) this.hide();
  };
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.hide();
  };

  constructor(private readonly container: HTMLElement, private readonly actions: ContextMenuActions) {
    this.root = document.createElement('div');
    this.root.className = 'camera-context-menu';
    Object.assign(this.root.style, {
      position: 'absolute',
      display: 'none',
      zIndex: '20',
      background: 'rgba(20, 20, 24, 0.92)',
      border: '1px solid rgba(255,255,255,0.25)',
      borderRadius: '8px',
      padding: '4px',
      font: '13px system-ui, sans-serif',
      color: '#eee',
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      minWidth: '120px',
      pointerEvents: 'auto',
    } as Partial<CSSStyleDeclaration>);
    container.appendChild(this.root);
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }

  get currentObjectId(): string | null {
    return this.objectId;
  }

  /** Show the menu for `obj` with its top-left corner just beside the click (client coordinates). */
  show(obj: EditableObject, clientX: number, clientY: number): void {
    this.objectId = obj.id;
    this.root.replaceChildren();
    const title = document.createElement('div');
    title.textContent = obj.userName;
    Object.assign(title.style, { padding: '4px 8px', opacity: '0.7', fontSize: '11px', whiteSpace: 'nowrap' } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(title);
    for (const item of menuItemsFor(obj, this.actions)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = item.label;
      b.dataset.menuAction = item.label.toLowerCase().replace(/\s+/g, '-');
      Object.assign(b.style, {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        color: item.disabledReason ? '#888' : '#fff',
        border: 'none',
        padding: '6px 8px',
        cursor: item.disabledReason ? 'not-allowed' : 'pointer',
        font: 'inherit',
        borderRadius: '4px',
      } as Partial<CSSStyleDeclaration>);
      if (item.disabledReason) b.title = item.disabledReason;
      b.addEventListener('pointerenter', () => {
        if (!item.disabledReason) b.style.background = 'rgba(255,255,255,0.12)';
      });
      b.addEventListener('pointerleave', () => {
        b.style.background = 'transparent';
      });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.disabledReason) return;
        this.hide();
        item.action();
      });
      this.root.appendChild(b);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.dataset.menuAction = 'close';
    Object.assign(close.style, { display: 'block', width: '100%', textAlign: 'left', background: 'transparent', color: '#aaa', border: 'none', padding: '6px 8px', cursor: 'pointer', font: 'inherit' } as Partial<CSSStyleDeclaration>);
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hide();
    });
    this.root.appendChild(close);

    const rect = this.container.getBoundingClientRect();
    this.root.style.display = 'block';
    // Keep the menu inside the container.
    const w = this.root.offsetWidth || 130;
    const h = this.root.offsetHeight || 160;
    let x = clientX - rect.left + 8;
    let y = clientY - rect.top + 8;
    if (x + w > rect.width) x = Math.max(0, clientX - rect.left - w - 8);
    if (y + h > rect.height) y = Math.max(0, rect.height - h - 4);
    this.root.style.left = `${x}px`;
    this.root.style.top = `${y}px`;
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    window.addEventListener('keydown', this.onKey);
  }

  hide(): void {
    if (!this.visible) return;
    this.root.style.display = 'none';
    this.objectId = null;
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    window.removeEventListener('keydown', this.onKey);
  }

  dispose(): void {
    this.hide();
    this.root.remove();
  }
}
