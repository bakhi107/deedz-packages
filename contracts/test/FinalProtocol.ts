import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, getAddress, keccak256, parseEther, stringToHex } from "viem";

describe("final consolidated DEEDZ protocol", async function () {
  const { viem, networkHelpers } = await network.create();
  const [owner, holder, buyer, team] = await viem.getWalletClients();
  const ticker = stringToHex("NVDA", { size: 32 });
  let rent: any, feed: any, treasury: any, rewards: any, exchange: any, liquidity: any, fees: any, settlement: any, deed: any, stock: any;

  beforeEach(async function () {
    rent = await viem.deployContract("RentToken", [owner.account.address]);
    feed = await viem.deployContract("TestPriceFeed", [owner.account.address, 2_000_000_000n]);
    treasury = await viem.deployContract("RentTreasury", [owner.account.address, owner.account.address, team.account.address, feed.address]);
    liquidity = await viem.deployContract("ProtocolLiquidity", [owner.account.address]);
    rewards = await viem.deployContract("StockRewards", [owner.account.address, owner.account.address]);
    exchange = await viem.deployContract("TestExchange", [owner.account.address, rent.address]);
    fees = await viem.deployContract("FeeProcessor", [owner.account.address, owner.account.address, rewards.address, exchange.address, liquidity.address, team.account.address]);
    settlement = await viem.deployContract("SundaySettlement", [owner.account.address, owner.account.address, treasury.address, rewards.address, rent.address, exchange.address, liquidity.address, team.account.address]);
    deed = await viem.deployContract("contracts/final/Deed.sol:Deed", [owner.account.address, rent.address, treasury.address, fees.address]);
    stock = await viem.deployContract("TestStockToken", ["NVDA", owner.account.address]);
    await treasury.write.configureDeed([deed.address]);
    await treasury.write.configureSettlement([settlement.address]);
    await rewards.write.setProcessor([fees.address, true]);
    await rewards.write.setProcessor([settlement.address, true]);
    await rewards.write.configureStock([ticker, stock.address]);
    await exchange.write.configureStock([ticker, stock.address, 1_000n * 10n ** 18n]);
    await exchange.write.setRentRate([1_000_000n * 10n ** 18n]);
    await stock.write.mint([exchange.address, 1_000_000n * 10n ** 18n]);
    await rent.write.transfer([exchange.address, 100_000_000n * 10n ** 18n]);
    await fees.write.setFeeSource([owner.account.address, true]);
    await fees.write.setFeeSource([deed.address, true]);
    await rent.write.transfer([holder.account.address, 100_000n * 10n ** 18n]);
    await rent.write.approve([deed.address, 100_000n * 10n ** 18n], { account: holder.account });
    await deed.write.mint([ticker], { account: holder.account });
  });

  async function light() {
    const daily = await treasury.read.dailyRentWei([8_000_000n]);
    const deposit = daily * 7n;
    await deed.write.light([1n, 8_000_000n], { account: holder.account, value: deposit });
    return { daily, deposit };
  }

  it("mints free, burns exactly 25,000 RENT, and derives Lit/grace/Dark from time", async function () {
    const supply = await rent.read.totalSupply(); const { daily } = await light();
    assert.equal(await rent.read.totalSupply(), supply - 25_000n * 10n ** 18n);
    assert.equal(await deed.read.stateOf([1n]), 1);
    await networkHelpers.time.increase(7 * 86_400 + 1);
    assert.equal(await deed.read.stateOf([1n]), 2);
    await feed.write.setPrice([2_000_000_000n]);
    await deed.write.topUpRent([1n], { account: holder.account, value: daily });
    assert.equal(await deed.read.stateOf([1n]), 1);
    await networkHelpers.time.increase(2 * 86_400 + 1);
    assert.equal(await deed.read.stateOf([1n]), 3);
  });

  it("scores the complete non-refundable deposit immediately but recognizes rent over time", async function () {
    const { deposit } = await light();
    const week = await treasury.read.weekOf([BigInt(await networkHelpers.time.latest())]);
    assert.equal(await treasury.read.clanScoreUsd6([week, ticker]), deposit * 2_000_000_000n / 10n ** 18n);
    assert.equal(await treasury.read.distributableRentEth([week]), 0n);
    await networkHelpers.time.increase(86_400);
    await feed.write.setPrice([2_000_000_000n]);
    await deed.write.setPrice([1n, 8_000_000n], { account: holder.account });
    assert.ok(await treasury.read.distributableRentEth([week]) > 0n);
  });

  it("moves unused runway to team on forced purchase while preserving the original score", async function () {
    const { deposit } = await light();
    const week = await treasury.read.weekOf([BigInt(await networkHelpers.time.latest())]);
    const score = await treasury.read.clanScoreUsd6([week, ticker]);
    const sale = await treasury.read.usdToEth([8_000_000n]);
    const fee = sale * 500n / 10_000n;
    const buyerDaily = await treasury.read.dailyRentWei([10_000_000n]);
    await deed.write.buy([1n, 10_000_000n], { account: buyer.account, value: sale + fee + buyerDaily * 7n });
    assert.equal(getAddress(await deed.read.ownerOf([1n])), getAddress(buyer.account.address));
    assert.ok(await treasury.read.teamBalance() <= deposit && await treasury.read.teamBalance() > deposit - 1_000_000_000n);
    assert.equal(await treasury.read.clanScoreUsd6([week, ticker]), score + buyerDaily * 7n * 2_000_000_000n / 10n ** 18n);
  });

  it("allows only the keeper to process one aggregated 70/20/10 cycle and leaves pull rewards claimable", async function () {
    await light();
    const feeAmount = parseEther("0.01");
    await fees.write.depositTradingFees([], { value: feeAmount });
    await networkHelpers.time.increase(3 * 3_600);
    const rewardEth = feeAmount * 70n / 100n;
    const stockOut = rewardEth * 1_000n;
    const inner = keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [0n, 1n, holder.account.address, stockOut],
    ));
    const root = keccak256(inner);
    await fees.write.processCycle([[{ ticker, ethAmount: rewardEth, minimumStockOut: stockOut, merkleRoot: root }]]);
    assert.equal(await liquidity.read.totalEthReceived(), feeAmount * 20n / 100n);
    await rewards.write.claim([0n, 1n, stockOut, []], { account: holder.account });
    assert.equal(await stock.read.balanceOf([holder.account.address]), stockOut);
  });

  it("settles earned weekly rent 50/25/20/5 and creates a winner-clan pull reward", async function () {
    await light();
    const week = await treasury.read.weekOf([BigInt(await networkHelpers.time.latest())]);
    const end = await treasury.read.weekEnd([week]);
    await networkHelpers.time.increaseTo(end + 1n);
    await treasury.write.checkpointWeek([week, 250n]);
    await treasury.write.finalizeWeek([week]);
    const total = await treasury.read.distributableRentEth([week]);
    const jackpotEth = total * 20n / 100n;
    const stockOut = jackpotEth * 1_000n;
    const inner = keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [0n, 1n, holder.account.address, stockOut],
    ));
    const supplyBefore = await rent.read.totalSupply();
    await settlement.write.settle([week, 0n, stockOut, keccak256(inner)]);
    assert.equal(await rent.read.totalSupply(), supplyBefore - total * 50n / 100n * 1_000_000n);
    assert.equal(await treasury.read.distributableRentEth([week]), 0n);
    assert.equal((await rewards.read.batches([0n]))[0], ticker);
  });
});
