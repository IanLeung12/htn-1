import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// `npm run dev:https` runs with --mode https, which loads a self-signed cert
// via @vitejs/plugin-basic-ssl so the Quest 3 browser can open the LAN URL as
// a secure context (required for navigator.xr / immersive-ar). `npm run dev`
// stays plain HTTP (localhost is already a secure context via adb reverse).
export default defineConfig(async ({ mode }) => {
  const plugins = [];
  if (mode === 'https') {
    const basicSsl = (await import('@vitejs/plugin-basic-ssl')).default;
    plugins.push(basicSsl());
  }

  return {
    plugins,
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
      // @iwer/sem bundles its own three copy; force one instance so scene objects interoperate.
      dedupe: ['three'],
    },
    server: {
      port: 5183,
      strictPort: true,
      proxy: {
        // calib.stereolabs.com doesn't send CORS headers, so the ZED
        // calibration loader (src/camera/stereo/zed-calib.ts) falls back to
        // this same-origin proxy in dev. `path` includes the query string
        // (e.g. "/zed-calib?sn=25491304"); rewrite it to the upstream's
        // "?SN=<serial>" form.
        '/zed-calib': {
          target: 'https://calib.stereolabs.com',
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/zed-calib\?sn=/i, '/?SN='),
        },
      },
    },
    // transformers.js ships its own onnxruntime-web bundles and worker-loaded
    // wasm; pre-bundling breaks its dynamic imports. Used only by the camera
    // backend's depth worker (src/camera/depth/worker.ts).
    optimizeDeps: { exclude: ['@huggingface/transformers'] },
    worker: { format: 'es' as const },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          sim: fileURLToPath(new URL('./sim.html', import.meta.url)),
          camera: fileURLToPath(new URL('./camera.html', import.meta.url)),
        },
      },
    },
  };
});
