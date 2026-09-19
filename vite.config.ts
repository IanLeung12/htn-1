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
    server: { port: 5177, strictPort: true },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          sim: fileURLToPath(new URL('./sim.html', import.meta.url)),
        },
      },
    },
  };
});
