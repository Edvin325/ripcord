// Real transactions anyone can look up, copied from evidence/. Nothing here comes from the
// simulator: these ran on Bitcoin testnet3, with NEAR testnet and its real MPC signers.

export const EXPLORER = 'https://mempool.space/testnet/tx/';

export const PROOFS = [
  {
    what: 'A NEAR contract spent native Bitcoin through lock 1, signed by the real MPC network in 8 seconds',
    txid: '30f9bbf37bc8dcfe9c08238252fb8c9c7ae19cc6c269ca303691e003e5f97d3c',
  },
  {
    what: 'Bitcoin refused the owner’s ticket before its block, then accepted it through lock 2, with no contract call',
    txid: '20c415dc01e777500e1c85dd7dfc0b1fc037c08c2a8f65685b7c4f6b93323047',
  },
];
