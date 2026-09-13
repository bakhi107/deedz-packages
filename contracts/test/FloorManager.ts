import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { stringToHex } from "viem";

describe("FloorManager", async function () {
  const { viem, networkHelpers } = await network.create();
  const [owner, reporter, token, feed] = await viem.getWalletClients();
  const ticker = stringToHex("NVDA", { size: 32 });

  let floorManager: Awaited<ReturnType<typeof viem.deployContract>>;

  beforeEach(async function () {
    const registry = await viem.deployContract("TickerRegistry", [owner.account.address]);
    await registry.write.listTicker([ticker, token.account.address, feed.account.address, 10]);
    const launchedAt = await networkHelpers.time.latest();
    floorManager = await viem.deployContract("FloorManager", [
      owner.account.address,
      registry.address,
      reporter.account.address,
      launchedAt,
    ]);
  });

  it("starts at the $5 minimum and rejects untrusted fee reports", async function () {
    assert.equal(await floorManager.read.floorOf([ticker]), 5_000_000n);
    await viem.assertions.revertWithCustomError(
      floorManager.write.recordFee([ticker, 1n], { account: owner.account }),
      floorManager,
      "UnauthorizedReporter",
    );
  });

  it("uses trailing fees and limits upward movement to 10% per elapsed day", async function () {
    // $21 across seven days => $0.30/Deed/day => $100 break-even at a 0.3% daily tax rate.
    await floorManager.write.recordFee([ticker, 21_000_000n], { account: reporter.account });
    assert.equal(await floorManager.read.previewTarget([ticker]), 10_000_000n);

    await networkHelpers.time.increase(86_400);
    await floorManager.write.syncFloor([ticker]);
    assert.equal(await floorManager.read.floorOf([ticker]), 5_500_000n);
  });

  it("ramps lambda from 10% to 50% over 90 days", async function () {
    assert.equal(await floorManager.read.lambdaBps(), 1_000n);
    await networkHelpers.time.increase(45 * 86_400);
    assert.equal(await floorManager.read.lambdaBps(), 3_000n);
    await networkHelpers.time.increase(45 * 86_400);
    assert.equal(await floorManager.read.lambdaBps(), 5_000n);
  });
});
