import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const rewardEligible = (state) => Number(state) === 1 || Number(state) === 2;

// Robinhood RPC nodes can briefly disagree about a just-mined receipt. Poll the
// same hash instead of sending another transaction when a node is behind.
export async function waitForKeeperReceipt(client, hash, { timeoutMs = 120_000, intervalMs = 2_000, sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (true) {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      if (receipt) return receipt;
    } catch (error) {
      if (!['TransactionReceiptNotFoundError', 'HttpRequestError', 'TimeoutError', 'RpcRequestError'].includes(error.name)) throw error;
      lastError = error;
    }
    if (Date.now() >= deadline) throw Error('Receipt still unavailable for ' + hash + '; do not resubmit blindly', { cause: lastError });
    await sleep(intervalMs);
  }
}

// Only public reward data is committed. No keys or environment files enter this directory.
export function persistKeeperData() {
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.DEEDZ_KEEPER_PERSIST_GIT !== '1') {
    throw Error('GitHub runner requires durable keeper state before broadcasting');
  }
  if (process.env.DEEDZ_KEEPER_PERSIST_GIT !== '1') return;
  const git = (...args) => execFileSync('git', args, { stdio: 'pipe' }).toString().trim();
  git('add', '-A', '--', 'keeper-data');
  if (git('diff', '--cached', '--name-only', '--', 'keeper-data')) {
    git('commit', '-m', 'Checkpoint testnet keeper reward proofs', '--', 'keeper-data');
  }
  // Fail closed: an unsuccessful push must prevent the next financial operation.
  git('push', 'origin', 'HEAD');
}

export function createRewardJournal({ rewardsAddress, directory = 'keeper-data', persist = persistKeeperData }) {
  const dir = resolve(directory), pending = resolve(dir, 'pending.json'), file = resolve(dir, 'rewards.json');
  const identity = { chainId: 46630, rewards: rewardsAddress.toLowerCase() };
  mkdirSync(dir, { recursive: true });
  const atomic = (path, data) => {
    writeFileSync(path + '.tmp', JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
    renameSync(path + '.tmp', path);
  };
  const check = (data) => {
    if (data.chainId !== identity.chainId || data.rewards !== identity.rewards) throw Error('Keeper state belongs to another deployment');
    return data;
  };
  async function publish(rewards, prepared) {
    const history = existsSync(file) ? check(JSON.parse(readFileSync(file, 'utf8'))) : { ...identity, batches: [] };
    for (const planned of prepared.batches) {
      const actual = await rewards.read.batches([BigInt(planned.id)]);
      const root = actual.root ?? actual[2], funded = actual.funded ?? actual[3];
      const total = planned.claims.reduce((sum, claim) => sum + BigInt(claim.amount), 0n);
      if (root.toLowerCase() !== planned.root.toLowerCase() || funded !== total) throw Error('On-chain reward batch does not match saved proofs');
      const old = history.batches.find(batch => batch.id === planned.id);
      if (old && old.root !== planned.root) throw Error('Conflicting reward history');
      if (!old) history.batches.push({ ...planned, transaction: prepared.hash, createdAt: prepared.createdAt });
    }
    atomic(file, history);
    persist();
    unlinkSync(pending);
    persist();
  }
  async function recover(client, rewards) {
    if (!existsSync(pending)) return false;
    const prepared = check(JSON.parse(readFileSync(pending, 'utf8')));
    const end = BigInt(prepared.batches.at(-1).id) + 1n;
    if (await rewards.read.batchCount() >= end) {
      await publish(rewards, prepared);
      console.log('RECOVERED: confirmed reward proofs');
      return true;
    }
    if (prepared.hash) {
      const receipt = await client.getTransactionReceipt({ hash: prepared.hash }).catch(() => null);
      if (receipt?.status === 'reverted') {
        unlinkSync(pending); persist();
        throw Error('Previous reward transaction reverted; journal cleared for next run');
      }
    }
    throw Error('Unresolved prepared reward transaction. Reconcile the keeper nonce and chain before clearing keeper-data/pending.json; no new transaction was sent.');
  }
  async function execute({ client, rewards, batches, submit }) {
    if (existsSync(pending)) throw Error('Recover pending rewards before submitting');
    if (!batches.length) throw Error('No reward batches');
    const prepared = { ...identity, batches, hash: null, createdAt: new Date().toISOString() };
    atomic(pending, prepared);
    persist(); // This MUST finish before submit, including on ephemeral GitHub runners.
    const hash = await submit();
    prepared.hash = hash; atomic(pending, prepared); persist();
    const receipt = await waitForKeeperReceipt(client, hash);
    if (receipt.status !== 'success') throw Error('Reward transaction reverted: ' + hash);
    await publish(rewards, prepared);
    return hash;
  }
  return { execute, recover };
}
