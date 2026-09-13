import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, zeroHash } from "viem";

describe("V6 RENT/ETH pool connectivity hook", async function () {
  const { viem, networkHelpers } = await network.create();
  const [owner] = await viem.getWalletClients();

  it("allows swaps only for the configured static-fee pool", async function () {
    const manager = await viem.deployContract("V4PoolManager", [owner.account.address]);
    const swapRouter = await viem.deployContract("V4SwapRouter", [manager.address]);
    const liquidityRouter = await viem.deployContract("V4LiquidityRouter", [manager.address]);
    const tokenA = await viem.deployContract("V4TestToken", [10n ** 30n]);
    const tokenB = await viem.deployContract("V4TestToken", [10n ** 30n]);
    const implementation = await viem.deployContract("RentHookV6PrototypeHarness", [
      manager.address,
      owner.account.address,
    ]);
    const publicClient = await viem.getPublicClient();
    const code = await publicClient.getCode({ address: implementation.address });
    assert.ok(code);
    const hookAddress = getAddress("0x0000000000000000000000000000000000000080");
    await networkHelpers.setCode(hookAddress, code!);
    const hook = await viem.getContractAt("RentHookV6PrototypeHarness", hookAddress);

    const [currency0, currency1] = BigInt(tokenA.address) < BigInt(tokenB.address)
      ? [tokenA, tokenB]
      : [tokenB, tokenA];
    const poolKey = {
      currency0: currency0.address,
      currency1: currency1.address,
      fee: 50_000,
      tickSpacing: 60,
      hooks: hookAddress,
    } as const;
    await hook.write.configurePool([poolKey]);
    await manager.write.initialize([poolKey, 2n ** 96n]);
    await currency0.write.approve([liquidityRouter.address, 10n ** 30n]);
    await currency1.write.approve([liquidityRouter.address, 10n ** 30n]);
    await currency0.write.approve([swapRouter.address, 10n ** 30n]);
    await liquidityRouter.write.modifyLiquidity([
      poolKey,
      { tickLower: -887_220, tickUpper: 887_220, liquidityDelta: 10n ** 18n, salt: zeroHash },
      "0x",
    ]);

    const before = await currency1.read.balanceOf([owner.account.address]);
    await swapRouter.write.swap([
      poolKey,
      { zeroForOne: true, amountSpecified: -(10n ** 15n), sqrtPriceLimitX96: 4_295_128_740n },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ]);
    assert.ok((await currency1.read.balanceOf([owner.account.address])) > before);
  });
});
