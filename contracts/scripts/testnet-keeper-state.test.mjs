import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRewardJournal, rewardEligible } from './testnet-keeper-state.mjs';
const address = '0x1234', hash = '0xabc', root = '0xdef';
const batches = [{ id:'0', root, claims:[{ amount:'7' }] }];
function fixture(t, persist=()=>{}) {
  const directory=mkdtempSync(join(tmpdir(),'deedz-journal-'));
  t.after(()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  let count=0n;
  const rewards={read:{batchCount:async()=>count,batches:async()=>['ticker','token',root,7n]}};
  const client={waitForTransactionReceipt:async()=>({status:'success'}),getTransactionReceipt:async()=>null};
  return {directory,rewards,client,journal:createRewardJournal({rewardsAddress:address,directory,persist}),fund:()=>{count=1n;}};
}
test('Lit and grace qualify; Dormant and Dark do not',()=>{assert.deepEqual([0,1,2,3].map(rewardEligible),[false,true,true,false]);});
test('durable write failure prevents transaction submission',async t=>{
  const f=fixture(t,()=>{throw Error('push failed');});let submitted=false;
  await assert.rejects(f.journal.execute({...f,batches,submit:async()=>{submitted=true;return hash;}}),/push failed/);
  assert.equal(submitted,false);
});
test('crash after broadcast recovers saved proofs on a fresh runner',async t=>{
  let checkpoints=0;
  const f=fixture(t,()=>{if(++checkpoints===2)throw Error('runner stopped');});
  await assert.rejects(f.journal.execute({...f,batches,submit:async()=>{f.fund();return hash;}}),/runner stopped/);
  const restarted=createRewardJournal({rewardsAddress:address,directory:f.directory,persist:()=>{}});
  assert.equal(await restarted.recover(f.client,f.rewards),true);
  assert.equal(await restarted.recover(f.client,f.rewards),false);
  const saved=JSON.parse(readFileSync(join(f.directory,'rewards.json'),'utf8'));
  assert.equal(saved.batches.length,1); assert.equal(saved.batches[0].transaction,hash);
});
test('unconfirmed plan blocks duplicates and preserves evidence',async t=>{
  const f=fixture(t);
  await assert.rejects(f.journal.execute({...f,batches,submit:async()=>{throw Error('connection lost');}}),/connection lost/);
  await assert.rejects(f.journal.recover(f.client,f.rewards),/Unresolved prepared/);
  assert.equal(existsSync(join(f.directory,'pending.json')),true);
});
test('remote checkpoint without a transaction hash still recovers a confirmed batch',async t=>{
  let saved,checks=0;
  const f=fixture(t,()=>{if(++checks===1)saved=readFileSync(join(f.directory,'pending.json'));else throw Error('lost runner');});
  await assert.rejects(f.journal.execute({...f,batches,submit:async()=>{f.fund();return hash;}}),/lost runner/);
  writeFileSync(join(f.directory,'pending.json'),saved);
  const restarted=createRewardJournal({rewardsAddress:address,directory:f.directory,persist:()=>{}});
  await restarted.recover(f.client,f.rewards);
  assert.equal(JSON.parse(readFileSync(join(f.directory,'rewards.json'),'utf8')).batches[0].transaction,null);
});
test('mismatched on-chain root is never published',async t=>{
  const f=fixture(t);f.rewards.read.batches=async()=>['ticker','token','0xwrong',7n];
  await assert.rejects(f.journal.execute({...f,batches,submit:async()=>{f.fund();return hash;}}),/does not match/);
  assert.equal(existsSync(join(f.directory,'rewards.json')),false);
});
