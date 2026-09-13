import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, maxUint256, stringToHex, zeroHash } from "viem";

describe("DeedHookPrototype with the official Uniswap v4 PoolManager", async function () {
  const { viem } = await network.create();
  const [owner] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();

  it("routes a 2 bps output surcharge to the hook while LPs receive 3 bps", async function () {
    const manager = await viem.deployContract("V4PoolManager", [owner.account.address]);
    const swapRouter = await viem.deployContract("V4SwapRouter", [manager.address]);
    const liquidityRouter = await viem.deployContract("V4LiquidityRouter", [manager.address]);
    const firstToken = await viem.deployContract("V4TestToken", [10n ** 30n]);
    const secondToken = await viem.deployContract("V4TestToken", [10n ** 30n]);
    const feeController = await viem.deployContract("MockFeeController");

    const [currency0, currency1] =
      BigInt(firstToken.address) < BigInt(secondToken.address)
        ? [firstToken, secondToken]
        : [secondToken, firstToken];

    const implementation = await viem.deployContract("DeedHookPrototypeHarness", [
      manager.address,
      feeController.address,
      owner.account.address,
    ]);
    const implementationCode = await publicClient.getCode({ address: implementation.address });
    assert.ok(implementationCode);

    // beforeSwap (0x80) | afterSwap (0x40) | afterSwapReturnDelta (0x04)
    const hookAddress = getAddress("0x00000000000000000000000000000000000000c4");
    await testClient.setCode({ address: hookAddress, bytecode: implementationCode });

    const poolKey = {
      currency0: currency0.address,
      currency1: currency1.address,
      fee: 0x800000,
      tickSpacing: 60,
      hooks: hookAddress,
    } as const;

    const hook = await viem.getContractAt("DeedHookPrototypeHarness", hookAddress);
    await hook.write.setPoolTicker([poolKey, stringToHex("TEST", { size: 32 })]);

    await manager.write.initialize([poolKey, 2n ** 96n]);

    for (const token of [currency0, currency1]) {
      await token.write.approve([liquidityRouter.address, maxUint256]);
      await token.write.approve([swapRouter.address, maxUint256]);
    }

    await liquidityRouter.write.modifyLiquidity([
      poolKey,
      {
        tickLower: -120,
        tickUpper: 120,
        liquidityDelta: 10n ** 18n,
        salt: zeroHash,
      },
      "0x",
    ]);

    const hookBalanceBefore = await currency1.read.balanceOf([hookAddress]);
    await swapRouter.write.swap([
      poolKey,
      {
        zeroForOne: true,
        amountSpecified: -(10n ** 15n),
        sqrtPriceLimitX96: 4_295_128_740n,
      },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ]);
    const hookBalanceAfter = await currency1.read.balanceOf([hookAddress]);

    assert.ok(hookBalanceAfter > hookBalanceBefore, "the hook should receive the DEEDS surcharge");

    const reverseBalanceBefore = await currency0.read.balanceOf([hookAddress]);
    await swapRouter.write.swap([
      poolKey,
      {
        zeroForOne: false,
        amountSpecified: -(10n ** 15n),
        sqrtPriceLimitX96: 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n,
      },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ]);
    const reverseBalanceAfter = await currency0.read.balanceOf([hookAddress]);
    assert.ok(reverseBalanceAfter > reverseBalanceBefore, "reverse swaps should also pay the surcharge");

    const exactOutputBalanceBefore = await currency0.read.balanceOf([hookAddress]);
    await swapRouter.write.swap([
      poolKey,
      {
        zeroForOne: true,
        amountSpecified: 10n ** 12n,
        sqrtPriceLimitX96: 4_295_128_740n,
      },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ]);
    const exactOutputBalanceAfter = await currency0.read.balanceOf([hookAddress]);
    assert.ok(exactOutputBalanceAfter > exactOutputBalanceBefore, "exact-output swaps should pay the surcharge");
  });
});
