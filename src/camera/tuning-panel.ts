/**
 * Live DOM panel of sliders for `CameraTuning` (see tuning.ts), styled like
 * the diagnostics panel (src/camera/diagnostics.ts) but bottom-right,
 * interactive, and grouped by TUNING_SPEC's `group`. Toggle with the `t` key.
 */
import { TUNING_SPEC, type CameraTuning, type TuningStore } from './tuning';

const GROUP_LABELS: Record<string, string> = {
  camera: 'Camera',
  depth: 'Depth',
  planes: 'Planes',
  volumes: 'Volumes',
};

const GROUP_ORDER: readonly (keyof typeof GROUP_LABELS)[] = ['camera', 'depth', 'planes', 'volumes'];

interface RowControls {
  range: HTMLInputElement;
  number: HTMLInputElement;
}

export interface TuningPanelOptions {
  visible?: boolean;
}

export class TuningPanel {
  readonly root: HTMLDivElement;
  private visible: boolean;
  private readonly store: TuningStore;
  private readonly rows = new Map<keyof CameraTuning, RowControls>();
  private readonly unsubscribe: () => void;

  constructor(container: HTMLElement, store: TuningStore, opts: TuningPanelOptions = {}) {
    this.store = store;
    this.visible = opts.visible ?? false;

    this.root = document.createElement('div');
    this.root.id = 'camera-tuning-panel';
    this.root.style.cssText = [
      'position:absolute',
      'right:8px',
      'bottom:8px',
      'z-index:11',
      'font:11px ui-monospace,Menlo,monospace',
      'color:#e8e8ee',
      'background:rgba(0,0,0,0.72)',
      'padding:8px 10px',
      'border-radius:6px',
      'width:280px',
      'max-height:60vh',
      'overflow:auto',
      'pointer-events:auto',
      `display:${this.visible ? 'block' : 'none'}`,
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'camera tuning (t to hide)';
    title.style.cssText = 'font-weight:bold;margin-bottom:6px;';
    this.root.appendChild(title);

    for (const group of GROUP_ORDER) {
      const heading = document.createElement('div');
      heading.textContent = GROUP_LABELS[group] ?? group;
      heading.style.cssText = 'margin:8px 0 4px;opacity:0.7;text-transform:uppercase;font-size:10px;letter-spacing:0.05em;';
      this.root.appendChild(heading);

      for (const key of Object.keys(TUNING_SPEC) as (keyof CameraTuning)[]) {
        const spec = TUNING_SPEC[key];
        if (spec.group !== group) continue;
        this.root.appendChild(this.buildRow(key));
      }
    }

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset';
    resetBtn.style.cssText = 'margin-top:8px;width:100%;font:inherit;padding:4px;cursor:pointer;';
    resetBtn.addEventListener('click', () => this.store.reset());
    this.root.appendChild(resetBtn);

    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());

    container.appendChild(this.root);

    window.addEventListener('keydown', this.onKey);
    this.unsubscribe = this.store.subscribe(this.onStoreChange);
  }

  private buildRow(key: keyof CameraTuning): HTMLDivElement {
    const spec = TUNING_SPEC[key];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:3px;';

    const label = document.createElement('label');
    label.textContent = spec.label;
    label.style.cssText = 'flex:0 0 100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    row.appendChild(label);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(spec.min);
    range.max = String(spec.max);
    range.step = String(spec.step);
    range.value = String(this.store.value[key]);
    range.style.cssText = 'flex:1 1 auto;min-width:0;';
    row.appendChild(range);

    const number = document.createElement('input');
    number.type = 'number';
    number.min = String(spec.min);
    number.max = String(spec.max);
    number.step = String(spec.step);
    number.value = String(this.store.value[key]);
    number.style.cssText = 'flex:0 0 56px;width:56px;font:inherit;';
    row.appendChild(number);

    const apply = (raw: string): void => {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      this.store.set(key, parsed);
    };

    range.addEventListener('input', () => {
      number.value = range.value;
      apply(range.value);
    });
    number.addEventListener('input', () => {
      apply(number.value);
    });
    number.addEventListener('change', () => {
      range.value = String(this.store.value[key]);
      number.value = String(this.store.value[key]);
    });

    this.rows.set(key, { range, number });
    return row;
  }

  private readonly onStoreChange = (t: CameraTuning, changedKey: keyof CameraTuning | null): void => {
    const keys = changedKey ? [changedKey] : (Object.keys(TUNING_SPEC) as (keyof CameraTuning)[]);
    for (const key of keys) {
      const controls = this.rows.get(key);
      if (!controls) continue;
      const value = String(t[key]);
      if (controls.range.value !== value) controls.range.value = value;
      if (controls.number.value !== value) controls.number.value = value;
    }
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      this.visible ? this.hide() : this.show();
    }
  };

  show(): void {
    this.visible = true;
    this.root.style.display = 'block';
  }

  hide(): void {
    this.visible = false;
    this.root.style.display = 'none';
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.unsubscribe();
    this.root.remove();
  }
}
