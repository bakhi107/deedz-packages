import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { stringToHex, zeroAddress } from "viem";

describe("FeeController", async function () {
  const { viem, networkHelpers } = await network.create();
  const [market, landlord, outsider, token, feed] = await viem.getWalletClients();
  const ticker = stringToHex("NVDA", { size: 32 });

  let controller: Awaited<ReturnType<typeof viem.deployContract>>;

  beforeEach(async function () {
    const registry = await viem.deployContract("TickerRegistry", [market.account.address]);
    await registry.write.listTicker([ticker, token.account.address, feed.account.address, 5]);
    const landlords = await viem.deployContract("LandlordRegistry", [market.account.address, registry.address]);
    await landlords.write.updateOwnership([ticker, zeroAddress, landlord.account.address]);
    controller = await viem.deployContract("FeeController", [landlords.address]);
  });

  it("lets only the current Landlord set a fee from 1 to 30 bps", async function () {
    assert.equal(await controller.read.feeBps([ticker]), 5);
    await viem.assertions.revertWithCustomError(
      controller.write.setFee([ticker, 10], { account: outsider.account }),
      controller,
      "NotLandlord",
    );
    await controller.write.setFee([ticker, 30], { account: landlord.account });
    assert.equal(await controller.read.feeBps([ticker]), 30);
    await networkHelpers.time.increase(3_600);
    await viem.assertions.revertWithCustomError(
      controller.write.setFee([ticker, 31], { account: landlord.account }),
      controller,
      "FeeOutOfRange",
    );
  });

  it("allows at most one change per hour", async function () {
    await controller.write.setFee([ticker, 10], { account: landlord.account });
    await viem.assertions.revertWithCustomError(
      controller.write.setFee([ticker, 12], { account: landlord.account }),
      controller,
      "FeeChangeTooSoon",
    );
    await networkHelpers.time.increase(3_600);
    await controller.write.setFee([ticker, 12], { account: landlord.account });
    assert.equal(await controller.read.feeBps([ticker]), 12);
  });
});
