// Loads the compiled contracts for tests and demos that run in Node. The committed copies
// in contracts/wasm mean a fresh clone needs no Rust. A local build in target/near wins, so
// a change to a contract is tested without copying anything.

import { existsSync, readFileSync } from 'node:fs';
import { createWorld } from './world.mjs';

function load(name) {
  const built = new URL(`../../target/near/${name}/${name}.wasm`, import.meta.url);
  return readFileSync(existsSync(built) ? built : new URL(`../../contracts/wasm/${name}.wasm`, import.meta.url));
}

export const compiled = () => ({
  ripcord: load('ripcord'),
  endowment: load('ripcord_endowment'),
  usdc: load('ripcord_test_usdc'),
});

export const nodeWorld = (options = {}) => createWorld({ wasm: compiled(), ...options });
