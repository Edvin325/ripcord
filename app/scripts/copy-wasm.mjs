// Copies the compiled contracts into the site, so the simulator runs the real binaries.
// Prefers a local build, and falls back to the committed copies, so a fresh clone needs no Rust.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(app, '..');
const out = join(app, 'public', 'wasm');
mkdirSync(out, { recursive: true });

for (const name of ['ripcord', 'ripcord_endowment', 'ripcord_test_usdc']) {
  const built = join(root, 'target', 'near', name, `${name}.wasm`);
  const committed = join(root, 'contracts', 'wasm', `${name}.wasm`);
  copyFileSync(existsSync(built) ? built : committed, join(out, `${name}.wasm`));
}
console.log('contracts copied to public/wasm');
