import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, stringToHex } from "viem";

describe("Deed market", async function () {
  const { viem, networkHelpers } = await network.create();
  const [owner, claimant, buyer, treasury, liquidityReceiver] =
    await viem.getWalletClients();

  const ticker = stringToHex("NVDA", { size: 32 });
  const initialPrice = 8_000_000n;
  const buyerPrice = 12_000_000n;
  const stockPrice = 50_000_000n;
  const taxDeposit = 10_000_000_000_000_000n;
  const eligibilityExpiry = 18_446_744_073_709_551_615n;

  let registry: Awaited<ReturnType<typeof viem.deployContract>>;
  let geoGate: Awaited<ReturnType<typeof viem.deployContract>>;
  let usdg: Awaited<ReturnType<typeof viem.deployContract>>;
  let stockToken: Awaited<ReturnType<typeof viem.deployContract>>;
  let priceFeed: Awaited<ReturnType<typeof viem.deployContract>>;
  let taxVault: Awaited<ReturnType<typeof viem.deployContract>>;
  let landlordRegistry: Awaited<ReturnType<typeof viem.deployContract>>;
  let floorManager: Awaited<ReturnType<typeof viem.deployContract>>;
  let deed: Awaited<ReturnType<typeof viem.deployContract>>;

  beforeEach(async function () {
    registry = await viem.deployContract("TickerRegistry", [owner.account.address]);
    geoGate = await viem.deployContract("GeoGate", [owner.account.address]);
    usdg = await viem.deployContract("MockUSDG");
    stockToken = await viem.deployContract("MockStockToken");
    priceFeed = await viem.deployContract("MockPriceOracle");
    taxVault = await viem.deployContract("TaxVault", [
      owner.account.address,
      liquidityReceiver.account.address,
      treasury.account.address,
    ]);
    landlordRegistry = await viem.deployContract("LandlordRegistry", [
      owner.account.address,
      registry.address,
    ]);
    const launchedAt = await networkHelpers.time.latest();
    floorManager = await viem.deployContract("FloorManager", [
      owner.account.address,
      registry.address,
      owner.account.address,
      launchedAt,
    ]);
    deed = await viem.deployContract("Deed", [
      registry.address,
      geoGate.address,
      taxVault.address,
      landlordRegistry.address,
      floorManager.address,
      usdg.address,
      treasury.account.address,
    ]);
    await taxVault.write.transferOwnership([deed.address]);
    await landlordRegistry.write.transferOwnership([deed.address]);

    const now = await networkHelpers.time.latest();
    await priceFeed.write.setPrice([stockPrice, BigInt(now)]);

    await registry.write.listTicker([
      ticker,
      stockToken.address,
      priceFeed.address,
      250,
    ]);
    await geoGate.write.setEligibility([claimant.account.address, eligibilityExpiry]);
    await geoGate.write.setEligibility([buyer.account.address, eligibilityExpiry]);
    await usdg.write.mint([claimant.account.address, 100_000_000n]);
    await usdg.write.mint([buyer.account.address, 100_000_000n]);
    await stockToken.write.mint([claimant.account.address, 10n ** 18n]);
    await stockToken.write.mint([buyer.account.address, 10n ** 18n]);
    await usdg.write.approve([deed.address, 100_000_000n], { account: claimant.account });
    await usdg.write.approve([deed.address, 100_000_000n], { account: buyer.account });
    await stockToken.write.approve([taxVault.address, 10n ** 18n], { account: claimant.account });
    await stockToken.write.approve([taxVault.address, 10n ** 18n], { account: buyer.account });
  });

  it("claims a Deed and sends the claim fee to treasury", async function () {
    await viem.assertions.emitWithArgs(
      deed.write.claim([ticker, initialPrice, taxDeposit], { account: claimant.account }),
      deed,
      "Claimed",
      [ticker, 1n, claimant.account.address, 1, initialPrice],
    );

    assert.equal(getAddress(await deed.read.ownerOf([1n])), getAddress(claimant.account.address));
    assert.equal(await deed.read.priceOf([1n]), initialPrice);
    assert.equal(await usdg.read.balanceOf([treasury.account.address]), 1_000_000n);
    const position = await taxVault.read.positionOf([1n]);
    assert.equal(getAddress(position.holder), getAddress(claimant.account.address));
    assert.equal(position.balance, taxDeposit);

    const uri = await deed.read.tokenURI([1n]);
    assert.ok(uri.startsWith("data:application/json;base64,"));
    const metadata = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
    assert.equal(metadata.name, "DEEDZ NVDA #1");
    assert.equal(metadata.attributes[2].value, "$8.00");
    assert.ok(metadata.image.startsWith("data:image/svg+xml;base64,"));
    const svg = Buffer.from(metadata.image.split(",")[1], "base64").toString("utf8");
    assert.match(svg, /NVDA/);
    assert.match(svg, /#1/);
    assert.match(svg, /DEED HOLDER/);
  });

  it("forces a purchase at the seller's current price", async function () {
    await deed.write.claim([ticker, initialPrice, taxDeposit], { account: claimant.account });
    const sellerBalanceBefore = await usdg.read.balanceOf([claimant.account.address]);
    const sellerStockBefore = await stockToken.read.balanceOf([claimant.account.address]);

    await viem.assertions.emitWithArgs(
      deed.write.buy([1n, buyerPrice, taxDeposit], { account: buyer.account }),
      deed,
      "Bought",
      [ticker, 1n, claimant.account.address, buyer.account.address, initialPrice, buyerPrice],
    );

    assert.equal(getAddress(await deed.read.ownerOf([1n])), getAddress(buyer.account.address));
    assert.equal(await deed.read.priceOf([1n]), buyerPrice);
    assert.equal(await usdg.read.balanceOf([claimant.account.address]), sellerBalanceBefore + initialPrice);
    assert.equal(await stockToken.read.balanceOf([claimant.account.address]), sellerStockBefore + taxDeposit);
    const position = await taxVault.read.positionOf([1n]);
    assert.equal(getAddress(position.holder), getAddress(buyer.account.address));
    assert.equal(position.balance, taxDeposit);
  });

  it("blocks ERC-721 transfers that bypass the market", async function () {
    await deed.write.claim([ticker, initialPrice, taxDeposit], { account: claimant.account });

    await viem.assertions.revertWithCustomError(
      deed.write.transferFrom([claimant.account.address, buyer.account.address, 1n], {
        account: claimant.account,
      }),
      deed,
      "MarketTransferOnly",
    );
  });

  it("keeps the old price for one block after repricing", async function () {
    await deed.write.claim([ticker, initialPrice, taxDeposit], { account: claimant.account });
    await deed.write.setPrice([1n, buyerPrice], { account: claimant.account });

    assert.equal(await deed.read.priceOf([1n]), initialPrice);
    await usdg.write.mint([owner.account.address, 1n]);
    assert.equal(await deed.read.priceOf([1n]), buyerPrice);
    assert.equal((await taxVault.read.positionOf([1n])).assessedPriceUsd6, initialPrice);
    await taxVault.write.accrue([1n]);
    assert.equal((await taxVault.read.positionOf([1n])).assessedPriceUsd6, buyerPrice);
  });

  it("gives owners 24 hours before an increased floor auto-lifts their price", async function () {
    await deed.write.claim([ticker, initialPrice, taxDeposit], { account: claimant.account });
    await floorManager.write.recordFee([ticker, 5_250_000_000n]);

    for (let day = 0; day < 5; day += 1) {
      await networkHelpers.time.increase(86_400);
      await floorManager.write.syncFloor([ticker]);
    }
    const raisedFloor = await floorManager.read.floorOf([ticker]);
    assert.ok(raisedFloor > initialPrice);
    assert.equal(await deed.read.priceOf([1n]), initialPrice);

    await networkHelpers.time.increase(86_400);
    assert.equal(await deed.read.priceOf([1n]), raisedFloor);
    await viem.assertions.emitWithArgs(
      deed.write.enforceFloor([1n], { account: buyer.account }),
      deed,
      "FloorEnforced",
      [1n, initialPrice, raisedFloor],
    );
    assert.equal((await deed.read.deedData([1n])).price, raisedFloor);
  });

  it("burns a depleted Deed and lets an eligible account reclaim the same serial", async function () {
    const minimumDeposit = await taxVault.read.minimumDeposit([
      priceFeed.address,
      initialPrice,
      3n * 86_400n,
    ]);
    await deed.write.claim([ticker, initialPrice, minimumDeposit], { account: claimant.account });

    await networkHelpers.time.increase(4 * 86_400);
    const now = await networkHelpers.time.latest();
    await priceFeed.write.setPrice([stockPrice, BigInt(now)]);
    await deed.write.foreclose([1n], { account: buyer.account });

    await viem.assertions.revertWithCustomError(deed.read.ownerOf([1n]), deed, "ERC721NonexistentToken");
    await deed.write.reclaim([1n, buyerPrice, taxDeposit], { account: buyer.account });
    assert.equal(getAddress(await deed.read.ownerOf([1n])), getAddress(buyer.account.address));
    const data = await deed.read.deedData([1n]);
    assert.equal(data.serial, 1);
    assert.equal(data.price, buyerPrice);
  });
});
