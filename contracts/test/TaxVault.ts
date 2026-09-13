import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";

describe("TaxVault", async function () {
  const { viem, networkHelpers } = await network.create();
  const [market, holder, liquidityReceiver, treasury] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const assessedPrice = 100_000_000n; // $100, six decimals
  const stockPrice = 50_000_000n; // $50 per Stock Token
  const threeDayDeposit = 18_000_000_000_000_000n; // 0.018 token

  let stockToken: Awaited<ReturnType<typeof viem.deployContract>>;
  let oracle: Awaited<ReturnType<typeof viem.deployContract>>;
  let vault: Awaited<ReturnType<typeof viem.deployContract>>;

  beforeEach(async function () {
    stockToken = await viem.deployContract("MockStockToken");
    oracle = await viem.deployContract("MockPriceOracle");
    vault = await viem.deployContract("TaxVault", [
      market.account.address,
      liquidityReceiver.account.address,
      treasury.account.address,
    ]);

    const now = await networkHelpers.time.latest();
    await oracle.write.setPrice([stockPrice, BigInt(now)]);
    await stockToken.write.mint([holder.account.address, 10n ** 20n]);
    await stockToken.write.approve([vault.address, 10n ** 20n], { account: holder.account });
  });

  it("accrues 0.3% daily tax in the Stock Token and accounts for the 90/10 split", async function () {
    await vault.write.openPosition([
      1n,
      holder.account.address,
      stockToken.address,
      oracle.address,
      assessedPrice,
      threeDayDeposit,
    ]);
    const opened = await vault.read.positionOf([1n]);

    await networkHelpers.time.increase(86_400);
    const freshTimestamp = await networkHelpers.time.latest();
    await oracle.write.setPrice([stockPrice, BigInt(freshTimestamp)]);
    const hash = await vault.write.accrue([1n]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const accrualBlock = await publicClient.getBlock({ blockNumber: receipt.blockNumber });

    const elapsed = accrualBlock.timestamp - opened.lastAccrued;
    const taxUsd6 = assessedPrice * 30n * elapsed / (10_000n * 86_400n);
    const expectedTaxTokens = taxUsd6 * 10n ** 18n / stockPrice;
    const position = await vault.read.positionOf([1n]);

    assert.equal(position.balance, threeDayDeposit - expectedTaxTokens);
    assert.equal(await vault.read.liquidityAccrued([stockToken.address]), expectedTaxTokens * 90n / 100n);
    assert.equal(await vault.read.treasuryAccrued([stockToken.address]), expectedTaxTokens - expectedTaxTokens * 90n / 100n);
    assert.equal(await vault.read.lifetimeTaxUsd6([holder.account.address]), expectedTaxTokens * stockPrice / 10n ** 18n);

    const liquidityAmount = expectedTaxTokens * 90n / 100n;
    const treasuryAmount = expectedTaxTokens - liquidityAmount;
    await vault.write.disburse([stockToken.address], { account: holder.account });
    assert.equal(await stockToken.read.balanceOf([liquidityReceiver.account.address]), liquidityAmount);
    assert.equal(await stockToken.read.balanceOf([treasury.account.address]), treasuryAmount);
    assert.equal(await vault.read.liquidityAccrued([stockToken.address]), 0n);
    assert.equal(await vault.read.treasuryAccrued([stockToken.address]), 0n);
  });

  it("reports approximately three days of initial runway", async function () {
    await vault.write.openPosition([
      1n,
      holder.account.address,
      stockToken.address,
      oracle.address,
      assessedPrice,
      threeDayDeposit,
    ]);

    const runway = await vault.read.runway([1n]);
    assert.equal(runway, 3n * 86_400n);
  });

  it("pauses rather than charging through a stale oracle", async function () {
    await vault.write.openPosition([
      1n,
      holder.account.address,
      stockToken.address,
      oracle.address,
      assessedPrice,
      threeDayDeposit,
    ]);
    await networkHelpers.time.increase(7_200);

    await viem.assertions.emit(
      vault.write.accrue([1n]),
      vault,
      "AccrualPaused",
    );
    const position = await vault.read.positionOf([1n]);
    assert.equal(position.balance, threeDayDeposit);
  });

  it("caps tax at the remaining balance and marks the position depleted", async function () {
    await vault.write.openPosition([
      1n,
      holder.account.address,
      stockToken.address,
      oracle.address,
      assessedPrice,
      threeDayDeposit,
    ]);
    await networkHelpers.time.increase(4 * 86_400);
    const freshTimestamp = await networkHelpers.time.latest();
    await oracle.write.setPrice([stockPrice, BigInt(freshTimestamp)]);

    await viem.assertions.emitWithArgs(
      vault.write.accrue([1n]),
      vault,
      "PositionDepleted",
      [1n],
    );
    assert.equal((await vault.read.positionOf([1n])).balance, 0n);
    await vault.write.closeDepleted([1n]);
    await viem.assertions.revertWithCustomError(
      vault.read.positionOf([1n]),
      vault,
      "PositionNotOpen",
    );
  });
});
