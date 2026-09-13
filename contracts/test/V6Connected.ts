import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, parseEther, stringToHex } from "viem";
import { deployConnectedV6 } from "../scripts/lib/deploy-v6-local.js";

const nvda = stringToHex("NVDA", { size: 32 });
async function light(f: Awaited<ReturnType<typeof deployConnectedV6>>, id = 1n) {
  await f.deed.write.mintDark([nvda], { account: f.alice.account });
  const deposit = await f.vault.read.minimumDeposit([40_000_000n, 7n * 86400n]);
  await f.deed.write.lightUp([id, 40_000_000n], { account: f.alice.account, value: deposit + deposit / 10n });
}

describe("Connected v6 economic release", () => {
  it("allocates one billion RENT and opens a permanently owned pool with a first-hour cap", async () => {
    const f = await deployConnectedV6();
    assert.equal(await f.rent.read.totalSupply(), parseEther("1000000000"));
    assert.equal(await f.rent.read.balanceOf([f.emitter.address]), parseEther("400000000"));
    assert.equal(await f.rent.read.balanceOf([f.fairLaunch.address]), parseEther("50000000"));
    assert.equal(await f.rent.read.balanceOf([f.liquidity.address]), parseEther("20000000"));
    const teamVesting = await f.viem.getContractAt("RentVestingV6", await f.allocation.read.teamVesting());
    assert.equal(await teamVesting.read.vested(), 0n);
    await assert.rejects(f.router.write.swapExactInputEthForRent([1n, f.launch + 86400n], { value: parseEther("0.01") }));
    await f.openLaunch();
    assert.ok(await f.liquidity.read.totalLiquidity() > 0n);
    assert.equal(await f.router.read.launchReady(), true);
    const deadline = (await f.client.getBlock()).timestamp + 300n;
    await f.router.write.swapExactInputEthForRent([1n, deadline], { account: f.bob.account, value: parseEther("0.02") });
    await assert.rejects(f.router.write.swapExactInputEthForRent([1n, deadline], { account: f.bob.account, value: parseEther("0.01") }));
    assert.equal(await f.router.read.firstHourSpentUsd6([f.bob.account.address]), 40_000_000n);
    // The contract exposes no decrease/remove/sweep function, even to its owner.
    assert.ok(f.liquidity.abi.every((entry) => entry.type !== "function" || !/remove|withdraw|sweep|rescue/i.test(entry.name)));
  });

  it("executes trade rewards, rent burn, LP reinvestment and pre-sale rewards without mixing buckets", async () => {
    const f = await deployConnectedV6(); await f.openLaunch(); await light(f);
    await f.networkHelpers.time.increase(3601); await f.refresh();
    let deadline = (await f.client.getBlock()).timestamp + 300n;
    await f.router.write.swapExactInputEthForRent([1n, deadline], { account: f.bob.account, value: parseEther("0.01") });
    await f.buyer.write.pullAndAllocateTradingFees();
    const batch = await f.rewards.read.batches([0n]);
    assert.equal(batch[3], parseEther("0.01") * 5n / 100n * 70n / 100n);
    await f.buyer.write.buyBatch([0n, 1n, deadline, "0x"]);
    await f.rewards.write.claimBatch([0n, f.alice.account.address, false], { account: f.alice.account });
    assert.ok(await f.stocks.NVDA.read.balanceOf([f.alice.account.address]) > 0n);
    await f.networkHelpers.time.increase(3600); await f.vault.write.accrue([1n]);
    const burnFunds = await f.vault.read.rentBuyBurnAccrued();
    assert.ok(burnFunds > 0n); await f.burn.write.pull();
    deadline = (await f.client.getBlock()).timestamp + 300n;
    const supply = await f.rent.read.totalSupply(); await f.burn.write.execute([burnFunds, 1n, deadline]);
    assert.ok(await f.rent.read.totalSupply() < supply);
    assert.equal(await f.burn.read.totalEthSpent(), burnFunds);
    const liquidityBefore = await f.liquidity.read.totalLiquidity();
    await f.liquidity.write.pull([f.router.address]); await f.liquidity.write.pull([f.vault.address]);
    const lpEth = await f.client.getBalance({ address: f.liquidity.address });
    const lpRent = await f.rent.read.balanceOf([f.liquidity.address]);
    await f.liquidity.write.reinvest([0n, 0n, lpEth, lpRent, 1n, deadline]);
    assert.ok(await f.liquidity.read.totalLiquidity() > liquidityBefore);
    const sale = await f.vault.read.usdToEth([40_000_000n]);
    const deposit = await f.vault.read.minimumDeposit([40_000_000n, 7n * 86400n]);
    const first = await f.rewards.read.batchCount();
    await f.deed.write.buyWithLimits([1n, 40_000_000n, sale, deadline], { account: f.bob.account, value: sale + sale * 4n / 100n + deposit });
    const saleBatch = await f.rewards.read.batches([first]);
    assert.equal(saleBatch[3], sale * 2n / 100n);
    assert.equal(await f.rewards.read.weightAt([nvda, f.alice.account.address, saleBatch[1]]), 2n);
    await f.founder.write.pullAndAllocate();
    assert.ok(await f.founder.read.founderPaid() <= await f.founder.read.entitlement());
  });

  it("isolates a failed burn swap and pays a finalized clan jackpot through stock snapshots", async () => {
    const f = await deployConnectedV6(); await f.openLaunch(); await light(f);
    await f.networkHelpers.time.increase(3600); await f.vault.write.accrue([1n]);
    await f.burn.write.pull();
    const funds = await f.client.getBalance({ address: f.burn.address });
    const deadline = (await f.client.getBlock()).timestamp + 300n;
    await f.burn.write.execute([funds, 10n ** 40n, deadline]);
    assert.equal(await f.client.getBalance({ address: f.burn.address }), funds);
    const currentWeek = await f.ledger.read.weekOf([(await f.client.getBlock()).timestamp]);
    await f.networkHelpers.time.increaseTo(await f.ledger.read.weekEnd([currentWeek]));
    for (let week = 0n; week <= currentWeek; ++week) { await f.vault.write.checkpointWeek([week, 100n]); await f.jackpot.write.settleWeek(); }
    assert.equal(await f.jackpot.read.nextWeek(), currentWeek + 1n);
    assert.ok(await f.rewards.read.batchCount() > 0n);
    const last = await f.rewards.read.batchCount() - 1n;
    assert.equal((await f.rewards.read.batches([last]))[0], nvda);
    await f.buyer.write.buyBatch([last, 1n, (await f.client.getBlock()).timestamp + 300n, "0x"]);
    await f.rewards.write.claimBatch([last, f.alice.account.address, false], { account: f.alice.account });
    assert.ok(await f.stocks.NVDA.read.balanceOf([f.alice.account.address]) > 0n);
  });

  it("keeps Throne auctions disconnected until week two and sends their proceeds only to LP", async () => {
    const f = await deployConnectedV6(); await f.openLaunch();
    await assert.rejects(f.auction.write.enable());
    await f.networkHelpers.time.increaseTo(f.launch + 8n * 86400n); await f.refresh();
    await f.deed.write.configurePhaseTwo([true, f.auction.address]); await f.auction.write.enable();
    const start = (await f.client.getBlock()).timestamp + 30n; const end = start + 300n;
    await f.auction.write.schedule([nvda, start, end]); await f.networkHelpers.time.increaseTo(start);
    await f.auction.write.bid([nvda], { account: f.alice.account, value: parseEther("0.1") });
    await f.auction.write.bid([nvda], { account: f.bob.account, value: parseEther("0.2") });
    assert.equal(await f.auction.read.refunds([f.alice.account.address]), parseEther("0.1"));
    await f.networkHelpers.time.increaseTo(end);
    const before = await f.client.getBalance({ address: f.liquidity.address }); await f.auction.write.settle([nvda]);
    assert.equal(await f.client.getBalance({ address: f.liquidity.address }), before + parseEther("0.2"));
    const throne = await f.thronePool.read.tokenId([nvda]); assert.equal(await f.deed.read.throne([throne]), true);
    await f.deed.write.lightUp([throne, 40_000_000n], { account: f.bob.account, value: parseEther("0.01") });
    assert.equal(await f.rewards.read.totalWeight([nvda]), 14n);
    await f.router.write.swapExactInputEthForRent([1n, end + 300n], { value: parseEther("0.01") });
    const count = await f.rewards.read.batchCount(); await f.thronePool.write.checkpoint();
    assert.equal(
      getAddress(await f.rewards.read.batchBeneficiary([count])),
      getAddress(f.bob.account.address),
    );
  });

  it("does not allow the phase-two rent subsidy to be withdrawn as free money", async () => {
    const f = await deployConnectedV6(); await f.openLaunch(); await light(f);
    await f.networkHelpers.time.increaseTo(f.launch + 30n * 86400n); await f.refresh();
    await f.discount.write.setEnabled([true]);
    await f.owner.sendTransaction({ to: f.discount.address, value: parseEther("1") });
    await f.rent.write.approve([f.discount.address, parseEther("10000")], { account: f.alice.account });
    await f.discount.write.payRent([1n, parseEther("10000"), 1n, (await f.client.getBlock()).timestamp + 300n], { account: f.alice.account });
    const subsidy = await f.vault.read.subsidyBalance([1n]); assert.ok(subsidy > 0n);
    const reserveBefore = await f.client.getBalance({ address: f.discount.address });
    await f.deed.write.darken([1n], { account: f.alice.account });
    await f.discount.write.recoverUnusedSubsidy();
    assert.ok(await f.client.getBalance({ address: f.discount.address }) > reserveBefore);
    assert.equal(await f.vault.read.subsidyBalance([1n]), 0n);
  });
});
