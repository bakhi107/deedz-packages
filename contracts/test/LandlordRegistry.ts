import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, stringToHex, zeroAddress } from "viem";

describe("LandlordRegistry", async function () {
  const { viem } = await network.create();
  const [market, alice, bob, carol, token, feed] = await viem.getWalletClients();
  const ticker = stringToHex("NVDA", { size: 32 });

  let landlordRegistry: Awaited<ReturnType<typeof viem.deployContract>>;

  beforeEach(async function () {
    const registry = await viem.deployContract("TickerRegistry", [market.account.address]);
    await registry.write.listTicker([ticker, token.account.address, feed.account.address, 10]);
    landlordRegistry = await viem.deployContract("LandlordRegistry", [market.account.address, registry.address]);
  });

  it("requires both a unique plurality and the 20% threshold", async function () {
    await landlordRegistry.write.updateOwnership([ticker, zeroAddress, alice.account.address]);
    assert.equal((await landlordRegistry.read.landlordOf([ticker]))[0], zeroAddress);

    await landlordRegistry.write.updateOwnership([ticker, zeroAddress, alice.account.address]);
    let landlord = await landlordRegistry.read.landlordOf([ticker]);
    assert.equal(getAddress(landlord[0]), getAddress(alice.account.address));
    assert.equal(landlord[1], 2n);
    assert.equal(landlord[2], 2_000n);

    await landlordRegistry.write.updateOwnership([ticker, zeroAddress, bob.account.address]);
    await landlordRegistry.write.updateOwnership([ticker, zeroAddress, bob.account.address]);
    assert.equal((await landlordRegistry.read.landlordOf([ticker]))[0], zeroAddress);

    await landlordRegistry.write.updateOwnership([ticker, zeroAddress, carol.account.address]);
    await landlordRegistry.write.updateOwnership([ticker, alice.account.address, carol.account.address]);
    await landlordRegistry.write.updateOwnership([ticker, bob.account.address, carol.account.address]);
    landlord = await landlordRegistry.read.landlordOf([ticker]);
    assert.equal(getAddress(landlord[0]), getAddress(carol.account.address));
  });

  it("keeps exact counts when holders enter, transfer, and leave the heap", async function () {
    await landlordRegistry.write.updateOwnership([ticker, zeroAddress, alice.account.address]);
    await landlordRegistry.write.updateOwnership([ticker, zeroAddress, alice.account.address]);
    await landlordRegistry.write.updateOwnership([ticker, zeroAddress, bob.account.address]);
    await landlordRegistry.write.updateOwnership([ticker, alice.account.address, bob.account.address]);
    await landlordRegistry.write.updateOwnership([ticker, alice.account.address, zeroAddress]);

    assert.equal(await landlordRegistry.read.deedCountOf([ticker, alice.account.address]), 0n);
    assert.equal(await landlordRegistry.read.deedCountOf([ticker, bob.account.address]), 2n);
    assert.equal(await landlordRegistry.read.holderCount([ticker]), 1n);
    assert.equal(getAddress((await landlordRegistry.read.landlordOf([ticker]))[0]), getAddress(bob.account.address));
  });
});
