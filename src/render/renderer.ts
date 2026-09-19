/**
 * WebGLRenderer setup for passthrough AR: alpha-enabled clear so camera
 * passthrough shows through unrendered pixels, XR enabled, capped pixel
 * ratio (perf budget), sRGB output, and a foveation hint that is a no-op
 * outside an XR session.
 */
import * as THREE from 'three';

export interface RendererHandle {
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  dispose(): void;
}

export function createRenderer(container: HTMLElement): RendererHandle {
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  container.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setClearColor(0x000000, 0); // alpha 0: passthrough shows through
  renderer.setPixelRatio(1);
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;

  try {
    renderer.xr.setFoveation(0.5);
  } catch {
    // Foveation control not available under emulation; harmless.
  }

  function handleResize(): void {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', handleResize);

  return {
    renderer,
    canvas,
    dispose(): void {
      window.removeEventListener('resize', handleResize);
      renderer.setAnimationLoop(null);
      renderer.dispose();
      canvas.remove();
    },
  };
}
