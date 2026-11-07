// Loads the compiled contracts from disk for tests and demos that run in Node.

import { readFileSync } from 'node:fs';
import { createWorld } from './world.mjs';

const load = (name) =>
  readFileSync(new URL(`../../target/near/${name}/${name}.wasm`, import.meta.url));

export const compiled = () => ({
  ripcord: load('ripcord'),
  endowment: load('ripcord_endowment'),
  usdc: load('ripcord_test_usdc'),
});

export const nodeWorld = (options = {}) => createWorld({ wasm: compiled(), ...options });
