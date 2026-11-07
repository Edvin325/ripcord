// Copies the compiled contracts into the site, so the simulator runs the real binaries.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(app, 'public', 'wasm');
mkdirSync(out, { recursive: true });

for (const name of ['ripcord', 'ripcord_endowment', 'ripcord_test_usdc']) {
  const from = join(app, '..', 'target', 'near', name, `${name}.wasm`);
  if (!existsSync(from)) {
    console.error(`missing ${from}. Run scripts/build-contracts.ps1 first.`);
    process.exit(1);
  }
  copyFileSync(from, join(out, `${name}.wasm`));
}
console.log('contracts copied to public/wasm');
