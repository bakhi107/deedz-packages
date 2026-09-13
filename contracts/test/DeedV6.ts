import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, stringToHex } from "viem";

describe("DEEDS v6 core lifecycle", async function () {
  const { viem, networkHelpers } = await network.create();
  const [owner, holder, buyer, burnBuyer, liquidity, jackpot, team, stockRewards] =
    await viem.getWalletClients();

  const ticker = stringToHex("NVDA", { size: 32 });
  const initialPrice = 8_000_000n;
  const newPrice = 12_000_000n;
  const eligibilityExpiry = 18_446_744_073_709_551_615n;

  let rent: Awaited<ReturnType<typeof viem.deployContract>>;
  let oracle: Awaited<ReturnType<typeof viem.deployContract>>;
  let gate: Awaited<ReturnType<typeof viem.deployContract>>;
  let vault: Awaited<ReturnType<typeof viem.deployContract>>;
  let rewards: Awaited<ReturnType<typeof viem.deployContract>>;
  let deed: Awaited<ReturnType<typeof viem.deployContract>>;

  beforeEach(async function () {
    rent = await viem.deployContract("RentTokenV6", [owner.account.address]);
    oracle = await viem.deployContract("MockPriceOracle");
    gate = await viem.deployContract("GeoGateV6", [owner.account.address]);
    const now = await networkHelpers.time.latest();
    await oracle.write.setPrice([2_000_000_000n, BigInt(now)]);
    vault = await viem.deployContract("RentVaultV6", [
      owner.account.address,
      oracle.address,
      burnBuyer.account.address,
      liquidity.account.address,
      jackpot.account.address,
      team.account.address,
    ]);
    rewards = await viem.deployContract("StockRewardsV6", [owner.account.address]);
    const stockToken = await viem.deployContract("MockStockToken");
    await rewards.write.configureTicker([ticker, stockToken.address]);
    deed = await viem.deployContract("DeedV6", [
      rent.address,
      gate.address,
      vault.address,
      rewards.address,
      stockRewards.account.address,
      liquidity.account.address,
      BigInt(now - 2 * 86_400),
    ]);
    await vault.write.configureDeed([deed.address]);
    await rewards.write.configureDeed([deed.address]);
    await gate.write.attest([holder.account.address, stringToHex("holder", { size: 32 }), eligibilityExpiry]);
    await gate.write.attest([buyer.account.address, stringToHex("buyer", { size: 32 }), eligibilityExpiry]);
    await rent.write.transfer([holder.account.address, 100_000n * 10n ** 18n]);
    await rent.write.approve([deed.address, 100_000n * 10n ** 18n], { account: holder.account });
  });

  async function mintAndLight(deposit?: bigint) {
    await deed.write.mintDark([ticker], { account: holder.account });
    const minimum = await vault.read.minimumDeposit([initialPrice, 7n * 86_400n]);
    await deed.write.lightUp([1n, initialPrice], {
      account: holder.account,
      value: deposit ?? minimum,
    });
    return minimum;
  }

  it("mints a free transferable Dark Deed with on-chain SVG art", async function () {
    await viem.assertions.emitWithArgs(
      deed.write.mintDark([ticker], { account: holder.account }),
      deed,
      "DarkMinted",
      [ticker, 1n, holder.account.address, 1],
    );

    await deed.write.transferFrom([holder.account.address, buyer.account.address, 1n], {
      account: holder.account,
    });
    assert.equal(getAddress(await deed.read.ownerOf([1n])), getAddress(buyer.account.address));
    const uri = await deed.read.tokenURI([1n]);
    const metadata = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
    assert.equal(metadata.attributes[1].value, "Dark");
    assert.ok(metadata.image.startsWith("data:image/svg+xml;base64,"));
  });

  it("burns 25,000 RENT and requires seven days of ETH rent to become Lit", async function () {
    await deed.write.mintDark([ticker], { account: holder.account });
    const minimum = await vault.read.minimumDeposit([initialPrice, 7n * 86_400n]);

    await viem.assertions.revertWithCustomError(
      deed.write.lightUp([1n, initialPrice], { account: holder.account, value: minimum - 1n }),
      vault,
      "DepositTooSmall",
    );
    const supplyBefore = await rent.read.totalSupply();
    await deed.write.lightUp([1n, initialPrice], { account: holder.account, value: minimum });
    assert.equal(await rent.read.totalSupply(), supplyBefore - 25_000n * 10n ** 18n);
    assert.equal((await deed.read.deedData([1n])).lit, true);
    assert.equal(await rewards.read.totalWeight([ticker]), 2n);
    assert.equal((await rewards.read.holderState([ticker, holder.account.address])).weight, 2n);

    await viem.assertions.revertWithCustomError(
      deed.write.transferFrom([holder.account.address, buyer.account.address, 1n], {
        account: holder.account,
      }),
      deed,
      "LitTransferRequiresSale",
    );
  });

  it("accrues 0.3% daily ETH rent and accounts for the 50/25/20/5 split", async function () {
    const deposit = await mintAndLight();
    await networkHelpers.time.increase(86_400);
    const now = await networkHelpers.time.latest();
    await oracle.write.setPrice([2_000_000_000n, BigInt(now)]);
    await vault.write.accrue([1n]);

    const daily = await vault.read.dailyRentWei([initialPrice]);
    const position = await vault.read.positionOf([1n]);
    const charged = deposit - position.balance;
    assert.ok(charged >= daily - daily / 100n && charged <= daily + daily / 100n);
    assert.equal(await vault.read.liquidityAccrued(), charged * 25n / 100n);
    assert.equal(await vault.read.jackpotAccrued(), charged * 20n / 100n);
    assert.equal(await vault.read.teamAccrued(), charged * 5n / 100n);
    assert.equal(
      await vault.read.rentBuyBurnAccrued(),
      charged * 50n / 100n,
    );
  });

  it("requires seven-day runway at a higher price and applies it after 60 seconds", async function () {
    await mintAndLight();
    await viem.assertions.revertWithCustomError(
      deed.write.setPrice([1n, newPrice], { account: holder.account }),
      vault,
      "DepositTooSmall",
    );
    const required = await vault.read.minimumDeposit([newPrice, 7n * 86_400n]);
    const balance = await vault.read.balanceOf([1n]);
    const transactionBuffer = await vault.read.dailyRentWei([newPrice]);
    await deed.write.topUpRent([1n], {
      account: holder.account,
      value: required - balance + transactionBuffer,
    });
    await deed.write.setPrice([1n, newPrice], { account: holder.account });
    assert.equal((await deed.read.deedData([1n])).priceUsd6, initialPrice);
    await networkHelpers.time.increase(60);
    assert.equal((await deed.read.deedData([1n])).priceUsd6, newPrice);
  });

  it("sells a Lit Deed for ETH plus 4% and starts the buyer with seven days of rent", async function () {
    await mintAndLight();
    const salePrice = await vault.read.usdToEth([initialPrice]);
    const fee = salePrice * 400n / 10_000n;
    const buyerDeposit = await vault.read.minimumDeposit([newPrice, 7n * 86_400n]);
    await deed.write.buy([1n, newPrice], {
      account: buyer.account,
      value: salePrice + fee + buyerDeposit,
    });

    assert.equal(getAddress(await deed.read.ownerOf([1n])), getAddress(buyer.account.address));
    assert.equal((await rewards.read.holderState([ticker, holder.account.address])).weight, 0n);
    assert.equal((await rewards.read.holderState([ticker, buyer.account.address])).weight, 2n);
    assert.equal((await vault.read.positionOf([1n])).balance, buyerDeposit);
    assert.equal((await rewards.read.batches([0n]))[3], fee / 2n);
    assert.equal(await deed.read.saleProceeds([holder.account.address]), salePrice);
    assert.equal(await deed.read.liquidityFeeAccrued(), fee - fee / 2n);
  });

  it("returns a depleted Lit Deed to Dark after the 24-hour grace period without burning it", async function () {
    await mintAndLight();
    for (let i = 0; i < 17; i++) {
      await networkHelpers.time.increase(12 * 3600);
      const checkpoint = await networkHelpers.time.latest();
      await oracle.write.setPrice([2_000_000_000n, BigInt(checkpoint)]);
      await vault.write.accrue([1n]);
    }
    const now = await networkHelpers.time.latest();
    await oracle.write.setPrice([2_000_000_000n, BigInt(now)]);
    await deed.write.lapse([1n], { account: buyer.account });

    assert.equal(getAddress(await deed.read.ownerOf([1n])), getAddress(holder.account.address));
    assert.equal((await deed.read.deedData([1n])).lit, false);
    assert.equal(await rewards.read.totalWeight([ticker]), 0n);
    await deed.write.transferFrom([holder.account.address, buyer.account.address, 1n], {
      account: holder.account,
    });
    assert.equal(getAddress(await deed.read.ownerOf([1n])), getAddress(buyer.account.address));
  });
});
