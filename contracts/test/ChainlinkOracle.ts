// @ts-nocheck
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";

describe("Production Chainlink adapter and final rent treasury", async () => {
  const { viem, networkHelpers: nh } = await network.create({ network: "stockUnit" });
  const [owner, team] = await viem.getWalletClients();
  let feed, oracle, treasury, timestamp;
  beforeEach(async () => {
    feed = await viem.deployContract("TestChainlinkRound", [8]);
    timestamp = BigInt(await nh.time.latest());
    await feed.write.setRound([1n, 269496250177n, timestamp, timestamp, 1n]);
    oracle = await viem.deployContract("EthUsdOracleV6", [feed.address]);
    treasury = await viem.deployContract("RentTreasury", [owner.account.address, owner.account.address, team.account.address, oracle.address]);
  });
  it("normalizes the real feed precision, preserves its timestamp and rounds ETH charges upward", async () => {
    assert.deepEqual(await oracle.read.latestPriceUsd6(), [2694962501n, timestamp]);
    const usd = 100_000_000n, price = 2694962501n;
    const expected = (usd * 10n ** 18n + price - 1n) / price;
    assert.equal(await treasury.read.usdToEth([usd]), expected);
    const daily = usd * 30n / 10000n;
    assert.equal(await treasury.read.dailyRentWei([usd]), (daily * 10n ** 18n + price - 1n) / price);
    await nh.time.increase(30);
    assert.equal((await oracle.read.latestPriceUsd6())[1], timestamp);
  });
  it("normalizes supported precisions without assuming eight decimals", async () => {
    for (const decimals of [0, 4, 6, 8, 18]) {
      const mock = await viem.deployContract("TestChainlinkRound", [decimals]);
      const now = BigInt(await nh.time.latest());
      await mock.write.setRound([1n, 2500n * 10n ** BigInt(decimals), now, now, 1n]);
      const adapter = await viem.deployContract("EthUsdOracleV6", [mock.address]);
      assert.equal((await adapter.read.latestPriceUsd6())[0], 2500000000n);
    }
    const unsupported = await viem.deployContract("TestChainlinkRound", [19]);
    await assert.rejects(viem.deployContract("EthUsdOracleV6", [unsupported.address]), /Unsupported precision/);
    await assert.rejects(viem.deployContract("EthUsdOracleV6", [owner.account.address]), /Feed contract required/);
  });
  it("rejects zero, negative and too-small prices", async () => {
    for (const answer of [0n, -1n, 1n, 99n]) {
      await feed.write.setRound([1n, answer, timestamp, timestamp, 1n]);
      await assert.rejects(oracle.read.latestPriceUsd6(), /Invalid oracle round|Oracle rounds to zero/);
      await assert.rejects(treasury.read.usdToEth([100000000n]));
    }
  });
  it("rejects incomplete rounds and zero/future timestamps", async () => {
    for (const round of [
      [0n, 250000000000n, timestamp, timestamp, 0n],
      [2n, 250000000000n, timestamp, timestamp, 1n],
      [1n, 250000000000n, 0n, 0n, 1n],
      [1n, 250000000000n, timestamp, timestamp + 3600n, 1n],
    ]) {
      await feed.write.setRound(round);
      await assert.rejects(oracle.read.latestPriceUsd6(), /Invalid oracle round/);
    }
  });
  it("enforces the existing 24-hour freshness limit and resumes after a fresh round", async () => {
    assert.equal(await treasury.read.MAX_ORACLE_AGE(), 86400n);
    await nh.time.increaseTo(timestamp + 86400n);
    assert.ok(await treasury.read.usdToEth([100000000n]) > 0n);
    await nh.time.increaseTo(timestamp + 86401n);
    await assert.rejects(treasury.read.usdToEth([100000000n]), /Oracle unavailable/);
    const fresh = BigInt(await nh.time.latest());
    await feed.write.setRound([2n, 300000000000n, fresh, fresh, 2n]);
    assert.equal((await oracle.read.latestPriceUsd6())[1], fresh);
    assert.equal(await treasury.read.dailyRentWei([100000000n]), 100000000000000n);
  });
  it("propagates upstream feed failures without substituting a made-up price", async () => {
    await feed.write.setUnavailable([true]);
    await assert.rejects(oracle.read.latestPriceUsd6(), /Feed unavailable/);
    await assert.rejects(treasury.read.dailyRentWei([100000000n]), /Feed unavailable/);
  });
});
