import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseEther, zeroHash } from "viem";

describe("V6 RENT fee router", async function () {
  const { viem, networkHelpers } = await network.create();
  const [owner, stockBuyer, liquidity, team, throne] = await viem.getWalletClients();

  it("charges both swap directions in ETH and accounts for every wei 70/20/9/1", async function () {
    const manager = await viem.deployContract("V4PoolManager", [owner.account.address]);
    const testSwapRouter = await viem.deployContract("V4SwapRouter", [manager.address]);
    const liquidityRouter = await viem.deployContract("V4LiquidityRouter", [manager.address]);
    const rent = await viem.deployContract("V4TestToken", [10n ** 30n]);
    const implementation = await viem.deployContract("RentHookV6Harness", [manager.address, owner.account.address]);
    const publicClient = await viem.getPublicClient();
    const code = await publicClient.getCode({ address: implementation.address });
    assert.ok(code);
    const hookAddress = getAddress("0x0000000000000000000000000000000000000080");
    await networkHelpers.setCode(hookAddress, code!);
    const hook = await viem.getContractAt("RentHookV6", hookAddress);
    const router = await viem.deployContract("RentFeeRouterV6", [
      manager.address,
      rent.address,
      hookAddress,
      stockBuyer.account.address,
      liquidity.account.address,
      team.account.address,
      throne.account.address,
    ]);
    const poolKey = {
      currency0: getAddress("0x0000000000000000000000000000000000000000"),
      currency1: rent.address,
      fee: 0,
      tickSpacing: 60,
      hooks: hookAddress,
    } as const;
    await hook.write.configurePool([poolKey, router.address]);
    await manager.write.initialize([poolKey, 1_000n * (2n ** 96n)]);
    await rent.write.approve([liquidityRouter.address, 10n ** 30n]);
    await liquidityRouter.write.modifyLiquidity([
      poolKey,
      { tickLower: -887_220, tickUpper: 887_220, liquidityDelta: 10n ** 15n, salt: zeroHash },
      "0x",
    ], { value: parseEther("0.001") });

    await assert.rejects(
      testSwapRouter.write.swap([
        poolKey,
        { zeroForOne: true, amountSpecified: -(10n ** 10n), sqrtPriceLimitX96: 4_295_128_740n },
        { takeClaims: false, settleUsingBurn: false },
        "0x",
      ], { value: 10n ** 10n }),
    );

    const now = await networkHelpers.time.latest();
    const ethInput = 10n ** 12n;
    await router.write.swapExactInputEthForRent([0n, BigInt(now + 300)], { value: ethInput });
    const firstFee = ethInput * 5n / 100n;
    assert.equal(await router.read.totalFeesCollected(), firstFee);
    assert.equal(await router.read.stockBuyerAccrued(), firstFee * 70n / 100n);
    assert.equal(await router.read.liquidityAccrued(), firstFee * 20n / 100n);
    assert.equal(await router.read.teamAccrued(), firstFee * 9n / 100n);
    assert.equal(await router.read.throneAccrued(), firstFee - firstFee * 70n / 100n - firstFee * 20n / 100n - firstFee * 9n / 100n);

    const rentInput = 10n ** 15n;
    await rent.write.approve([router.address, rentInput]);
    await router.write.swapExactInputRentForEth([rentInput, 0n, BigInt(now + 300)]);
    const total = await router.read.totalFeesCollected();
    assert.ok(total > firstFee);
    assert.equal(
      await router.read.stockBuyerAccrued()
        + await router.read.liquidityAccrued()
        + await router.read.teamAccrued()
        + await router.read.throneAccrued(),
      total,
    );
    assert.equal(await publicClient.getBalance({ address: router.address }), total);
  });
});
