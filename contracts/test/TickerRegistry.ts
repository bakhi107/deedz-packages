import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, stringToHex, zeroAddress } from "viem";

describe("TickerRegistry", async function () {
  const { viem } = await network.create();
  const [owner, stockToken, priceFeed] = await viem.getWalletClients();

  it("lists and reads an active ticker", async function () {
    const registry = await viem.deployContract("TickerRegistry", [owner.account.address]);
    const ticker = stringToHex("NVDA", { size: 32 });

    await viem.assertions.emitWithArgs(
      registry.write.listTicker([ticker, stockToken.account.address, priceFeed.account.address, 250]),
      registry,
      "TickerListed",
      [ticker, stockToken.account.address, priceFeed.account.address, 250],
    );

    const config = await registry.read.getTicker([ticker]);
    assert.equal(getAddress(config.stockToken), getAddress(stockToken.account.address));
    assert.equal(getAddress(config.priceFeed), getAddress(priceFeed.account.address));
    assert.equal(config.deedSupply, 250);
    assert.equal(config.active, true);
  });

  it("rejects unusable token configuration", async function () {
    const registry = await viem.deployContract("TickerRegistry", [owner.account.address]);

    await viem.assertions.revertWithCustomError(
      registry.write.listTicker([stringToHex("NVDA", { size: 32 }), zeroAddress, priceFeed.account.address, 250]),
      registry,
      "InvalidAddress",
    );
  });
});
