// @ts-nocheck
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { stringToHex } from "viem";
import { shareTree, registerRewardClaims } from "../scripts/stock/keeper.js";

describe("Single-argument stock rewards", async () => {
  const { viem } = await network.create({ network: "stockUnit" });
  const [owner, holder, buyer] = await viem.getWalletClients();
  const ticker = stringToHex("NVDA", { size: 32 });
  let stock, rewards;
  beforeEach(async () => {
    stock = await viem.deployContract("TestStockToken", ["NVDA", owner.account.address]);
    rewards = await viem.deployContract("StockRewards", [owner.account.address, owner.account.address]);
    await rewards.write.configureStock([ticker, stock.address]);
    await stock.write.mint([owner.account.address, 1000000n]);
    await stock.write.approve([rewards.address, 1000000n]);
  });
  async function fund(holders, amount = 100n, clan = ticker) {
    const id = await rewards.read.batchCount(), m = shareTree(id, clan, holders);
    await rewards.write.createShareBatch([clan, m.root, amount, BigInt(holders.length)]);
    return m;
  }
  const entries = m => m.claims.map(c => ({ tokenId: BigInt(c.tokenId), account: c.account, amount: BigInt(c.shareIndex), proof: c.proof }));
  const register = m => rewards.write.registerClaims([BigInt(m.id), entries(m)], { account: buyer.account });
  const send = (c, name, args) => c.write[name](args);
  it("credits exact shares without transfers and pays only the entitled wallet once", async () => {
    const m = await fund([1n, 2n, 3n].map(id => ({ id, owner: holder.account.address })));
    await register(m); await register(m);
    assert.equal(await stock.read.balanceOf([holder.account.address]), 0n);
    assert.equal(await rewards.read.rewardTokenCount([holder.account.address]), 3n);
    assert.equal(await rewards.read.claimInterfaceVersion(), 1n);
    let total = 0n;
    for (const c of m.claims) {
      const id = BigInt(c.tokenId), amount = await rewards.read.shareAmount([0n, BigInt(c.shareIndex)]);
      assert.equal(await rewards.read.claimableStock([holder.account.address, id]), amount);
      await assert.rejects(rewards.write.claimStockRewards([id], { account: buyer.account }));
      await rewards.write.claimStockRewards([id], { account: holder.account });
      await assert.rejects(rewards.write.claimStockRewards([id], { account: holder.account }));
      assert.equal(await rewards.read.claimedStock([holder.account.address, id]), amount);
      total += amount;
    }
    assert.equal(total, 100n); assert.equal(await stock.read.balanceOf([rewards.address]), 0n);
    await register(m); assert.equal(await rewards.read.claimableStock([holder.account.address, 1n]), 0n);
  });
  it("aggregates multiple cycles and preserves old and new holder entitlements separately", async () => {
    for (const amount of [100n, 200n]) await register(await fund([{ id: 1n, owner: holder.account.address }], amount));
    await register(await fund([{ id: 1n, owner: buyer.account.address }], 75n));
    await rewards.write.claimStockRewards([1n], { account: buyer.account });
    assert.equal(await stock.read.balanceOf([buyer.account.address]), 75n);
    assert.equal(await rewards.read.claimableStock([holder.account.address, 1n]), 300n);
    await rewards.write.claimStockRewards([1n], { account: holder.account });
    assert.equal(await stock.read.balanceOf([holder.account.address]), 300n);
    await register(await fund([{ id: 1n, owner: holder.account.address }], 25n));
    await rewards.write.claimStockRewards([1n], { account: holder.account });
    assert.equal(await rewards.read.claimedStock([holder.account.address, 1n]), 325n);
  });
  it("shares replay protection with direct proof claims in both orders", async () => {
    const m = await fund([{ id: 1n, owner: holder.account.address }, { id: 2n, owner: holder.account.address }]);
    const c = m.claims.find(c => c.tokenId === "1");
    await rewards.write.claim([0n, 1n, BigInt(c.shareIndex), c.proof], { account: holder.account });
    await register(m);
    assert.equal(await rewards.read.claimableStock([holder.account.address, 1n]), 0n);
    const other = m.claims.find(c => c.tokenId === "2");
    await assert.rejects(rewards.write.claim([0n, 2n, BigInt(other.shareIndex), other.proof], { account: holder.account }));
    await rewards.write.claimStockRewards([2n], { account: holder.account });
    assert.equal(await stock.read.balanceOf([holder.account.address]), 100n);
  });
  it("rejects altered proof data atomically", async () => {
    const m = await fund([{ id: 1n, owner: holder.account.address }, { id: 2n, owner: holder.account.address }]);
    for (const replacement of [{ account: buyer.account.address }, { tokenId: 3n }, { amount: 249n }]) {
      const invalid = entries(m); invalid[1] = { ...invalid[1], ...replacement };
      await assert.rejects(rewards.write.registerClaims([0n, invalid]));
      assert.equal(await rewards.read.rewardTokenCount([holder.account.address]), 0n);
      assert.equal((await rewards.read.batches([0n]))[4], 0n);
    }
  });
  it("bounds registration and discovery and recovers interrupted keeper publication", async () => {
    const m = await fund(Array.from({ length: 51 }, (_, i) => ({ id: BigInt(i + 1), owner: holder.account.address })), 1000n);
    await assert.rejects(rewards.write.registerClaims([0n, entries(m)]));
    await assert.rejects(rewards.write.registerClaims([0n, []]));
    let sends = 0;
    await assert.rejects(registerRewardClaims(rewards, [m], async (...args) => { if (++sends === 2) throw Error("Interrupted"); return send(...args); }));
    assert.equal(await rewards.read.rewardTokenCount([holder.account.address]), 25n);
    await registerRewardClaims(rewards, [m], send);
    await registerRewardClaims(rewards, [m], async () => { throw Error("Unexpected replay"); });
    assert.equal(await rewards.read.rewardTokenCount([holder.account.address]), 51n);
    assert.equal((await rewards.read.rewardTokenIds([holder.account.address, 0n, 50n])).length, 50);
    assert.equal((await rewards.read.rewardTokenIds([holder.account.address, 50n, 50n])).length, 1);
    assert.deepEqual(await rewards.read.rewardTokenIds([holder.account.address, 100n, 50n]), []);
    await assert.rejects(rewards.read.rewardTokenIds([holder.account.address, 0n, 51n]));
  });
});
