import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

const from = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Relative paths, so the built site works from any host, a subfolder or a plain file server.
  base: './',
  plugins: [preact()],
  resolve: {
    alias: {
      '@tools': from('../tools'),
      // The shared code in ../tools must use this app's copy of the crypto libraries.
      '@noble/curves': from('./node_modules/@noble/curves'),
      '@noble/hashes': from('./node_modules/@noble/hashes'),
    },
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  server: { port: 4173, fs: { allow: ['..'] } },
});
