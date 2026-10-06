import test from 'node:test';
import assert from 'node:assert/strict';
import { withRpcReadRetry } from './rpc-read-retry.mjs';

test('lagging node retries the exact pinned read and succeeds', async () => {
  const args = { method: 'eth_call', params: [{ to: '0x1234' }, '0x7bdb2aa'] };
  let calls = 0, sleeps = 0;
  const read = withRpcReadRetry(async actual => {
    assert.strictEqual(actual, args);
    if (++calls < 3) throw { cause: { details: 'unsupported block number 129872554' } };
    return '0x01';
  }, { sleep: async () => { sleeps++; } });
  assert.equal(await read(args), '0x01'); assert.equal(calls, 3); assert.equal(sleeps, 2);
});
test('read retries stop after the configured limit', async () => {
  let calls = 0;
  const read = withRpcReadRetry(async () => { calls++; throw Error('header not found'); }, { attempts: 3, sleep: async () => {} });
  await assert.rejects(read({ method: 'eth_getBlockByNumber' }), /header not found/); assert.equal(calls, 3);
});
test('transaction submissions are never retried by the read wrapper', async () => {
  let calls = 0;
  const read = withRpcReadRetry(async () => { calls++; throw Error('unsupported block number'); }, { sleep: async () => {} });
  await assert.rejects(read({ method: 'eth_sendRawTransaction' })); assert.equal(calls, 1);
});
test('contract reverts remain visible without retry', async () => {
  let calls = 0;
  const read = withRpcReadRetry(async () => { calls++; throw Error('execution reverted: Only keeper'); }, { sleep: async () => {} });
  await assert.rejects(read({ method: 'eth_call' }), /Only keeper/); assert.equal(calls, 1);
});
