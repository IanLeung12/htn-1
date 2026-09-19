/**
 * Deterministic textured-image generator for optical-flow tests
 * (tests/unit/camera-flow.test.ts, tests/unit/camera-visual-pose.test.ts).
 * Produces a large "world" grayscale buffer once, then crops fixed-size
 * windows out of it at chosen offsets - two windows at offsets that differ
 * by (dx, dy) are pixel-exact translations of each other, which is what
 * makes the recovered flow's expected value exact rather than approximate.
 */

/** Mulberry32: tiny deterministic PRNG, seeded, no external dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticWorld {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * A checkerboard of randomly-toned 8x8 blocks plus per-pixel noise: block
 * edges give strong, well-spread corners; the noise keeps interior gradients
 * non-degenerate so Lucas-Kanade windows never see a perfectly flat patch.
 */
export function makeSyntheticWorld(width: number, height: number, seed: number, blockSize = 8): SyntheticWorld {
  const rand = mulberry32(seed);
  const data = new Float32Array(width * height);
  const blocksX = Math.ceil(width / blockSize);
  const blocksY = Math.ceil(height / blockSize);
  const blockValue = new Float32Array(blocksX * blocksY);
  for (let i = 0; i < blockValue.length; i++) {
    blockValue[i] = 40 + rand() * 180;
  }
  for (let y = 0; y < height; y++) {
    const by = Math.floor(y / blockSize);
    for (let x = 0; x < width; x++) {
      const bx = Math.floor(x / blockSize);
      const base = blockValue[by * blocksX + bx] ?? 128;
      const noise = (rand() - 0.5) * 16;
      data[y * width + x] = Math.max(0, Math.min(255, base + noise));
    }
  }
  return { data, width, height };
}

/** Crop a `width x height` window out of `world` starting at (`x0`, `y0`); out-of-range pixels clamp to the edge. */
export function cropWorld(world: SyntheticWorld, x0: number, y0: number, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(Math.max(y0 + y, 0), world.height - 1);
    for (let x = 0; x < width; x++) {
      const sx = Math.min(Math.max(x0 + x, 0), world.width - 1);
      out[y * width + x] = world.data[sy * world.width + sx] ?? 0;
    }
  }
  return out;
}

/** Grayscale Float32Array -> RGBA Uint8ClampedArray (R=G=B=gray, A=255), for feeding GrabbedFrame consumers. */
export function grayToRgba(gray: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] ?? 0;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}
