// @ts-nocheck -- Hardhat's generated viem types are resolved at runtime.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  concatHex, encodeAbiParameters, encodeFunctionData, getAddress, hashTypedData, keccak256,
  padHex, parseEther, stringToHex, zeroAddress,
} from "viem";
import { deployConnectedV6 } from "../scripts/lib/deploy-v6-local.js";

const nvda = stringToHex("NVDA", { size: 32 });

describe("V6 release safety gates", () => {
  it("lets the reviewed launcher seed after governance ownership is handed off", async () => {
    const f = await deployConnectedV6();
    await f.fairLaunch.write.setLauncher([f.bob.account.address]);
    await f.fairLaunch.write.transferOwnership([f.treasury.account.address]);
    await f.networkHelpers.time.increaseTo(f.launch + 2n * 86400n);
    await f.oracle.write.setPrice([2_000_000_000n, (await f.client.getBlock()).timestamp]);
    await f.owner.sendTransaction({ to: f.fairLaunch.address, value: parseEther("2") });
    await assert.rejects(f.fairLaunch.write.seed());
    await f.fairLaunch.write.seed({ account: f.bob.account });
    assert.equal(await f.fairLaunch.read.seeded(), true);
    assert.equal(await f.rent.read.balanceOf([f.liquidity.address]), parseEther("70000000"));
  });

  it("separates attestation and hook administration from the deployer", async () => {
    const f = await deployConnectedV6();
    await f.gate.write.setAttester([f.bob.account.address]);
    await assert.rejects(f.gate.write.attest([f.treasury.account.address, stringToHex("treasury", { size: 32 }), f.launch + 86400n]));
    await f.gate.write.attest([f.treasury.account.address, stringToHex("treasury", { size: 32 }), f.launch + 86400n], { account: f.bob.account });
    assert.equal(getAddress(await f.gate.read.attester()), getAddress(f.bob.account.address));

    await f.hook.write.transferAdmin([f.bob.account.address]);
    assert.equal(getAddress(await f.hook.read.admin()), getAddress(f.bob.account.address));
    await assert.rejects(f.hook.write.transferAdmin([f.owner.account.address]));
    await f.hook.write.transferAdmin([f.owner.account.address], { account: f.bob.account });
  });

  it("keeps the day-30 locker disabled and funds its 30% rewards exactly", async () => {
    const f = await deployConnectedV6();
    const source = await f.viem.deployContract("RevenueSourceHarnessV6");
    await assert.rejects(f.lockers.write.configure([true, source.address]));
    await f.networkHelpers.time.increaseTo(f.launch + 30n * 86400n);
    await f.lockers.write.configure([true, source.address]);
    await f.rent.write.approve([f.lockers.address, parseEther("1000")], { account: f.alice.account });
    const unlockAt = (await f.client.getBlock()).timestamp + 7n * 86400n + 60n;
    await f.lockers.write.lock([parseEther("1000"), unlockAt], { account: f.alice.account });
    await assert.rejects(source.write.notify([f.lockers.address, parseEther("1")], { value: parseEther("0.29") }));
    await source.write.notify([f.lockers.address, parseEther("1")], { value: parseEther("0.3") });
    const before = await f.client.getBalance({ address: f.bob.account.address });
    await f.lockers.write.claim([f.bob.account.address], { account: f.alice.account });
    assert.equal(await f.client.getBalance({ address: f.bob.account.address }), before + parseEther("0.3"));
    await f.networkHelpers.time.increaseTo(unlockAt);
    await f.lockers.write.unlock({ account: f.alice.account });
    assert.equal((await f.lockers.read.locks([f.alice.account.address]))[0], 0n);
  });

  it("accepts one signed, identity-budgeted paymaster mint and rejects replay", async () => {
    const connection = await network.create();
    const { viem, networkHelpers } = connection;
    const client = await viem.getPublicClient();
    const [owner, alice] = await viem.getWalletClients();
    const entryPoint = await viem.deployContract("PaymasterEntryPointHarnessV6");
    const target = await viem.deployContract("RejectingHolderV6", [alice.account.address]);
    const launch = (await client.getBlock()).timestamp + 30n;
    const paymaster = await viem.deployContract("PaymasterV6", [entryPoint.address, target.address, owner.account.address, launch, parseEther("0.1"), parseEther("0.01"), parseEther("1")]);
    await paymaster.write.configure([true, owner.account.address]);
    const runtime = await client.getCode({ address: target.address });
    await paymaster.write.allowAccountCode([keccak256(runtime), true]);
    await networkHelpers.time.increaseTo(launch);

    const inner = encodeFunctionData({ abi: [{ type: "function", name: "mintDark", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] }], functionName: "mintDark", args: [nvda] });
    const callData = encodeFunctionData({ abi: target.abi, functionName: "execute", args: [target.address, 0n, inner] });
    const prefix = concatHex([paymaster.address, padHex("0x", { size: 32 })]);
    const identity = stringToHex("verified-person", { size: 32 });
    const validUntil = launch + 86400n;
    const limit = parseEther("0.01");
    const op = { sender: target.address, nonce: 0n, initCode: "0x", callData, accountGasLimits: padHex("0x", { size: 32 }), preVerificationGas: 0n, gasFees: padHex("0x", { size: 32 }), paymasterAndData: prefix, signature: "0x" };
    const digest = await paymaster.read.sponsorshipHash([op, identity, validUntil, limit]);
    const operation = keccak256(encodeAbiParameters([
      { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" },
    ], [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), op.accountGasLimits,
      op.preVerificationGas, op.gasFees, keccak256(prefix), entryPoint.address]));
    const typed = {
      domain: { name: "DEEDS launch sponsorship", version: "6", chainId: await client.getChainId(), verifyingContract: paymaster.address },
      types: { Sponsorship: [
        { name: "operation", type: "bytes32" }, { name: "identity", type: "bytes32" },
        { name: "validUntil", type: "uint48" }, { name: "maxCost", type: "uint256" },
      ] },
      primaryType: "Sponsorship",
      message: { operation, identity, validUntil, maxCost: limit },
    } as const;
    assert.equal(hashTypedData(typed), digest);
    const signature = await owner.signTypedData({ account: owner.account, ...typed });
    op.paymasterAndData = concatHex([prefix, encodeAbiParameters([
      { type: "bytes32" }, { type: "uint48" }, { type: "uint256" }, { type: "bytes" },
    ], [identity, validUntil, limit, signature])]);
    await entryPoint.write.validate([paymaster.address, op, limit]);
    assert.equal(await paymaster.read.mintAttempts([identity]), 1);
    assert.notEqual(await entryPoint.read.validationData(), 1n);
    await assert.rejects(entryPoint.write.validate([paymaster.address, op, limit]));
    await assert.rejects(paymaster.write.allowAccountCode([padHex("0x", { size: 32 }), true]));
  });

  it("locks Stock Token swaps to one reviewed router, token, deadline and minimum output", async () => {
    const connection = await network.create();
    const { viem } = connection;
    const client = await viem.getPublicClient();
    const [, alice] = await viem.getWalletClients();
    const weth = await viem.deployContract("WrappedEthHarnessV6");
    const stock = await viem.deployContract("MockStockToken");
    const router = await viem.deployContract("SwapRouterHarnessV6", [weth.address, stock.address]);
    const adapter = await viem.deployContract("StockRouterAdapterV6", [router.address, weth.address, stock.address, 500]);
    const deadline = (await client.getBlock()).timestamp + 300n;

    await adapter.write.swapExactEthForToken([stock.address, parseEther("2"), deadline, "0x"], {
      account: alice.account, value: parseEther("1"),
    });
    assert.equal(await stock.read.balanceOf([alice.account.address]), parseEther("2"));
    assert.equal(await weth.read.allowance([adapter.address, router.address]), 0n);
    await assert.rejects(adapter.write.swapExactEthForToken([weth.address, 1n, deadline, "0x"], { account: alice.account, value: 1n }));
    await assert.rejects(adapter.write.swapExactEthForToken([stock.address, 1n, deadline + 3600n, "0x"], { account: alice.account, value: 1n }));
    await assert.rejects(adapter.write.swapExactEthForToken([stock.address, 3n, deadline, "0x1234"], { account: alice.account, value: 1n }));
  });
});
