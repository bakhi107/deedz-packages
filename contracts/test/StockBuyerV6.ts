import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseEther, stringToHex } from "viem";

describe("V6 StockBuyer and Stock Token rewards", async function () {
  const { viem, networkHelpers } = await network.create();
  const [owner, holder, secondHolder, stranger] = await viem.getWalletClients();
  const nvda = stringToHex("NVDA", { size: 32 });
  const tsla = stringToHex("TSLA", { size: 32 });

  let rewards: Awaited<ReturnType<typeof viem.deployContract>>;
  let buyer: Awaited<ReturnType<typeof viem.deployContract>>;
  let source: Awaited<ReturnType<typeof viem.deployContract>>;
  let stockNvda: Awaited<ReturnType<typeof viem.deployContract>>;
  let stockTsla: Awaited<ReturnType<typeof viem.deployContract>>;

  beforeEach(async function () {
    rewards = await viem.deployContract("StockRewardsV6", [owner.account.address]);
    source = await viem.deployContract("MockTradingFeeSource");
    stockNvda = await viem.deployContract("MockStockToken");
    stockTsla = await viem.deployContract("MockStockToken");
    const adapter = await viem.deployContract("MockStockSwapAdapter", [1_000n * 10n ** 18n]);
    await rewards.write.configureTicker([nvda, stockNvda.address]);
    await rewards.write.configureTicker([tsla, stockTsla.address]);
    await rewards.write.configureDeed([owner.account.address]);
    buyer = await viem.deployContract("StockBuyerV6", [
      owner.account.address,
      owner.account.address,
      rewards.address,
    ]);
    await buyer.write.configureFeeSource([source.address]);
    await rewards.write.configureStockBuyer([buyer.address]);
    await buyer.write.configureRoute([nvda, adapter.address]);
    await buyer.write.configureRoute([tsla, adapter.address]);
  });

  it("allocates ETH by Lit weight, buys Stock Tokens, and lets holders claim", async function () {
    await rewards.write.onLight([nvda, holder.account.address]);
    await rewards.write.onLight([tsla, secondHolder.account.address]);
    await owner.sendTransaction({ to: source.address, value: parseEther("0.7") });
    await buyer.write.pullAndAllocateTradingFees({ account: stranger.account });

    assert.equal((await rewards.read.batches([0n]))[3], parseEther("0.35"));
    assert.equal((await rewards.read.batches([1n]))[3], parseEther("0.35"));
    const now = await networkHelpers.time.latest();
    await buyer.write.buyStock([nvda, 350n * 10n ** 18n, BigInt(now + 300), "0x"]);
    assert.equal((await rewards.read.batches([0n]))[4], 350n * 10n ** 18n);

    const before = await stockNvda.read.balanceOf([holder.account.address]);
    await rewards.write.claimBatch([0n, holder.account.address, false], { account: holder.account });
    assert.equal(await stockNvda.read.balanceOf([holder.account.address]), before + 350n * 10n ** 18n);
  });

  it("keeps earned rewards with the seller and gives later rewards to the new holder", async function () {
    await rewards.write.onLight([nvda, holder.account.address]);
    await owner.sendTransaction({ to: source.address, value: parseEther("0.2") });
    await buyer.write.pullAndAllocateTradingFees();
    let now = await networkHelpers.time.latest();
    await buyer.write.buyStock([nvda, 200n * 10n ** 18n, BigInt(now + 300), "0x"]);

    await rewards.write.onLitTransfer([nvda, holder.account.address, secondHolder.account.address]);
    await owner.sendTransaction({ to: source.address, value: parseEther("0.1") });
    await buyer.write.pullAndAllocateTradingFees();
    now = await networkHelpers.time.latest();
    await buyer.write.buyStock([nvda, 100n * 10n ** 18n, BigInt(now + 300), "0x"]);

    await rewards.write.claimBatch([0n, holder.account.address, false], { account: holder.account });
    await rewards.write.claimBatch([1n, secondHolder.account.address, false], { account: secondHolder.account });
    assert.equal(await stockNvda.read.balanceOf([holder.account.address]), 200n * 10n ** 18n);
    assert.equal(await stockNvda.read.balanceOf([secondHolder.account.address]), 100n * 10n ** 18n);
  });

  it("rejects unapproved execution and preserves ETH when no Deed is Lit", async function () {
    await owner.sendTransaction({ to: source.address, value: parseEther("0.1") });
    await buyer.write.pullAndAllocateTradingFees({ account: stranger.account });
    assert.equal(await buyer.read.unallocatedEth(), parseEther("0.1"));
    assert.equal(await buyer.read.totalEthSpent(), 0n);

    await rewards.write.onLight([nvda, holder.account.address]);
    await buyer.write.pullAndAllocateTradingFees({ account: stranger.account });
    const now = await networkHelpers.time.latest();
    await assert.rejects(
      buyer.write.buyStock([nvda, 0n, BigInt(now + 300), "0x"], { account: stranger.account }),
    );
    assert.equal(getAddress(await buyer.read.executor()), getAddress(owner.account.address));
  });
});
