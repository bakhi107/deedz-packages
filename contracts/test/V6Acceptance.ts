import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { stringToHex, parseEther, encodeFunctionData, getAddress } from "viem";

const nvda = stringToHex("NVDA", { size: 32 });
const tsla = stringToHex("TSLA", { size: 32 });
const identity = (name: string) => stringToHex(name, { size: 32 });

async function fixture(gated = false) {
  const connection = await network.create();
  const { viem, networkHelpers: time } = connection;
  const [governor, alice, bob, lp, jackpot, team] = await viem.getWalletClients();
  const client = await viem.getPublicClient();
  const now = BigInt(await time.time.latest());
  const launch = gated ? now : now - 2n * 86400n;
  const rent = await viem.deployContract("RentTokenV6", [governor.account.address]);
  const oracle = await viem.deployContract("MockPriceOracle");
  await oracle.write.setPrice([2_000_000_000n, now]);
  const gate = await viem.deployContract("GeoGateV6", [governor.account.address]);
  const ledger = await viem.deployContract("RentLedgerV6", [governor.account.address, launch]);
  const vault = await viem.deployContract("RentVaultV6", [governor.account.address, oracle.address, governor.account.address, lp.account.address, jackpot.account.address, team.account.address]);
  await vault.write.configureLedger([ledger.address]);
  await ledger.write.configureVault([vault.address]);
  const rewards = await viem.deployContract("StockRewardsV6", [governor.account.address]);
  const stock = await viem.deployContract("MockStockToken");
  await rewards.write.configureTicker([nvda, stock.address]);
  await rewards.write.configureTicker([tsla, stock.address]);
  const deed = await viem.deployContract("DeedV6", [rent.address, gate.address, vault.address, rewards.address, rewards.address, lp.account.address, launch]);
  await vault.write.configureDeed([deed.address]);
  await rewards.write.configureDeed([deed.address]);
  const buyer = await viem.deployContract("StockBuyerV6", [governor.account.address, governor.account.address, rewards.address]);
  const source = await viem.deployContract("MockTradingFeeSource");
  const adapter = await viem.deployContract("MockStockSwapAdapter", [1000n * 10n ** 18n]);
  await buyer.write.configureFeeSource([source.address]);
  await rewards.write.configureStockBuyer([buyer.address]);
  await buyer.write.configureRoute([nvda, adapter.address]);
  await buyer.write.configureRoute([tsla, adapter.address]);
  for (const [wallet, name] of [[alice, "alice"], [bob, "bob"]] as const) {
    await gate.write.attest([wallet.account.address, identity(name), now + 1000n * 86400n]);
    await rent.write.transfer([wallet.account.address, 2_000_000n * 10n ** 18n]);
    await rent.write.approve([deed.address, 2_000_000n * 10n ** 18n], { account: wallet.account });
  }
  const index = await viem.getContractAt("RentIndexV6", await vault.read.rentIndex());
  async function refresh(price = 2_000_000_000n) {
    const at = BigInt(await time.time.latest());
    await oracle.write.setPrice([price, at]); await index.write.sync();
  }
  async function mintLight(ticker = nvda, wallet = alice, price = 40_000_000n) {
    const before = await client.getBlockNumber();
    await deed.write.mintDark([ticker], { account: wallet.account });
    const events = await deed.getEvents.DarkMinted({}, { fromBlock: before });
    const id = events.at(-1)!.args.tokenId!;
    const deposit = await vault.read.minimumDeposit([price, 7n * 86400n]);
    await deed.write.lightUp([id, price], { account: wallet.account, value: deposit + deposit / 100n });
    return id;
  }
  return { ...connection, time, client, governor, alice, bob, lp, jackpot, team, launch, rent, oracle, gate, ledger, vault, rewards, stock, buyer, source, adapter, deed, index, refresh, mintLight };
}

describe("V6 specification acceptance", () => {
  it("allows open minting without identity approval", async () => {
    const f = await fixture(true);
    await f.deed.write.mintDark([nvda], { account: f.team.account });
    await f.deed.write.mintDark([tsla], { account: f.team.account });
    assert.equal(getAddress(await f.deed.read.ownerOf([1n])), getAddress(f.team.account.address));
    assert.equal(getAddress(await f.deed.read.ownerOf([2n])), getAddress(f.team.account.address));
  });

  it("does not back-bill stale time or reprice old rent after a feed change", async () => {
    const f = await fixture(); const id = await f.mintLight();
    const deposit = (await f.vault.read.positionOf([id])).balance;
    await f.time.time.increase(5 * 86400);
    const staleBalance = await f.vault.read.balanceOf([id]);
    assert.ok(deposit - staleBalance < deposit / 6n);
    await f.refresh(4_000_000_000n);
    await f.vault.write.accrue([id]);
    const after = (await f.vault.read.positionOf([id])).balance;
    assert.ok(staleBalance - after < 10n ** 10n);
    await f.time.time.increase(3600);
    await f.vault.write.accrue([id]);
    const charged = after - (await f.vault.read.positionOf([id])).balance;
    assert.ok(charged > 1_200_000_000_000n && charged < 1_300_000_000_000n);
  });

  it("keeps pending-price reserves and settles the exact delay boundary at the old rate", async () => {
    const f = await fixture(); const id = await f.mintLight();
    await f.deed.write.topUpRent([id], { account: f.alice.account, value: parseEther("0.1") });
    await f.deed.write.setPrice([id, 80_000_000n], { account: f.alice.account });
    const p = await f.vault.read.positionOf([id]);
    const oldOneDay = await f.vault.read.minimumDeposit([40_000_000n, 86400n]);
    await assert.rejects(f.deed.write.withdrawRent([id, p.balance - oldOneDay * 2n], { account: f.alice.account }));
    const prior = await f.vault.read.positionOf([id]);
    await f.time.time.setNextBlockTimestamp(prior.pendingPriceAt);
    await f.vault.write.accrue([id]);
    const after = await f.vault.read.positionOf([id]);
    const oldRateExpected = 40_000_000n * ((await f.index.read.indexAt([prior.pendingPriceAt])) - (await f.index.read.indexAt([prior.accruedAt]))) / 10n ** 27n;
    assert.ok(prior.balance - after.balance >= oldRateExpected && prior.balance - after.balance <= oldRateExpected + 1n);
    assert.equal(after.priceUsd6, 80_000_000n);
  });

  it("preserves pre-sale stock rights before conversion and provides ETH fallback on failure", async () => {
    const f = await fixture(); const id = await f.mintLight();
    await f.governor.sendTransaction({ to: f.source.address, value: parseEther("0.1") });
    const sale = await f.vault.read.usdToEth([40_000_000n]);
    const deposit = await f.vault.read.minimumDeposit([40_000_000n, 7n * 86400n]);
    await f.deed.write.buy([id, 40_000_000n], { account: f.bob.account, value: sale + sale * 4n / 100n + deposit });
    const batch = await f.rewards.read.batches([0n]);
    assert.equal(await f.rewards.read.weightAt([nvda, f.alice.account.address, batch[1]]), 2n);
    assert.equal(await f.rewards.read.weightAt([nvda, f.bob.account.address, batch[1]]), 0n);
    const deadline = BigInt(await f.time.time.latest()) + 300n;
    await f.buyer.write.buyBatch([0n, 10n ** 40n, deadline, "0x"]);
    assert.equal((await f.rewards.read.batches([0n]))[6], true);
    const before = await f.client.getBalance({ address: f.lp.account.address });
    await f.rewards.write.claimBatch([0n, f.lp.account.address, true], { account: f.alice.account });
    assert.equal(await f.client.getBalance({ address: f.lp.account.address }), before + batch[3]);
    await assert.rejects(f.rewards.write.claimBatch([0n, f.bob.account.address, true], { account: f.bob.account }));
    assert.equal(await f.deed.read.saleProceeds([f.alice.account.address]), sale);
  });

  it("cannot force an owner change through a stale pending light transaction", async () => {
    const f = await fixture();
    await f.deed.write.mintDark([nvda], { account: f.alice.account });
    await f.deed.write.transferFrom([f.alice.account.address, f.bob.account.address, 1n], { account: f.alice.account });
    await assert.rejects(f.deed.write.lightUp([1n, 5_000_000n], { account: f.alice.account, value: parseEther("0.01") }));
    assert.equal(getAddress(await f.deed.read.ownerOf([1n])), getAddress(f.bob.account.address));
  });

  it("forces a sale even when the seller rejects ETH, then lets that seller claim elsewhere", async () => {
    const f = await fixture();
    const wallet = await f.viem.deployContract("RejectingHolderV6", [f.alice.account.address]);
    await f.gate.write.attest([wallet.address, identity("contract holder"), f.launch + 100n * 86400n]);
    await f.rent.write.transfer([wallet.address, parseEther("25000")]);
    await wallet.write.execute([f.rent.address, 0n, encodeFunctionData({ abi: f.rent.abi, functionName: "approve", args: [f.deed.address, parseEther("25000")] })], { account: f.alice.account });
    await wallet.write.execute([f.deed.address, 0n, encodeFunctionData({ abi: f.deed.abi, functionName: "mintDark", args: [nvda] })], { account: f.alice.account });
    const deposit = await f.vault.read.minimumDeposit([40_000_000n, 7n * 86400n]);
    await wallet.write.execute([f.deed.address, deposit, encodeFunctionData({ abi: f.deed.abi, functionName: "lightUp", args: [1n, 40_000_000n] })], { account: f.alice.account, value: deposit });
    const price = await f.vault.read.usdToEth([40_000_000n]);
    await f.deed.write.buy([1n, 40_000_000n], { account: f.bob.account, value: price + price * 4n / 100n + deposit });
    assert.equal(getAddress(await f.deed.read.ownerOf([1n])), getAddress(f.bob.account.address));
    const before = await f.client.getBalance({ address: f.lp.account.address });
    await wallet.write.execute([f.deed.address, 0n, encodeFunctionData({ abi: f.deed.abi, functionName: "claimSaleProceeds", args: [f.lp.account.address] })], { account: f.alice.account });
    assert.equal(await f.client.getBalance({ address: f.lp.account.address }), before + price);
    assert.ok(await f.vault.read.refunds([wallet.address]) > 0n);
  });

  it("keeps permanent fusion weight through darkening and relighting", async () => {
    const f = await fixture();
    const a = await f.mintLight(); const b = await f.mintLight();
    await assert.rejects(f.deed.write.fuse([a, b, 40_000_000n], { account: f.alice.account, value: parseEther("0.01") }));
    await f.time.time.increaseTo(f.launch + 8n * 86400n);
    await f.refresh();
    // Stale time did not consume the balance; both positions remain Lit.
    await f.deed.write.configurePhaseTwo([true, "0x0000000000000000000000000000000000000000"]);
    const supply = await f.rent.read.totalSupply();
    await f.deed.write.fuse([a, b, 40_000_000n], { account: f.alice.account, value: parseEther("0.01") });
    assert.equal(await f.rent.read.totalSupply(), supply - parseEther("50000"));
    assert.equal(await f.rewards.read.totalWeight([nvda]), 7n);
    await assert.rejects(f.deed.read.ownerOf([b]));
    await f.deed.write.darken([a], { account: f.alice.account });
    assert.equal(await f.rewards.read.totalWeight([nvda]), 0n);
    await f.deed.write.lightUp([a, 40_000_000n], { account: f.alice.account, value: parseEther("0.01") });
    assert.equal(await f.rewards.read.totalWeight([nvda]), 7n);
    assert.equal(await f.deed.read.fused([a]), true);
  });

  it("keeps all ETH accounted for across frequent accrual and bucket claims", async () => {
    const f = await fixture(); const id = await f.mintLight();
    const funded = (await f.vault.read.positionOf([id])).balance;
    for (let i = 0; i < 20; ++i) { await f.time.time.increase(17); await f.vault.write.accrue([id]); }
    const p = await f.vault.read.positionOf([id]);
    const burn = await f.vault.read.rentBuyBurnAccrued();
    const lp = await f.vault.read.liquidityAccrued();
    const jackpot = await f.vault.read.jackpotAccrued();
    const team = await f.vault.read.teamAccrued();
    const dust = await f.vault.read.unallocatedRentDust();
    assert.equal(funded, p.balance + burn + lp + jackpot + team + dust);
    assert.ok(dust < 4n);
    await f.vault.write.claimBucket();
    assert.equal(await f.client.getBalance({ address: f.vault.address }), funded - burn);
    const lifetime = await f.ledger.read.lifetimeRentUsd6([f.alice.account.address]);
    assert.equal(lifetime, await f.vault.read.lifetimeRentUsd6([id]));
    assert.ok(lifetime > 0n);
  });

  it("seals weeks only after bounded settlement and emits capped retroactive rewards", async () => {
    const f = await fixture(); await f.mintLight(); await f.mintLight(tsla, f.bob);
    const emitter = await f.viem.deployContract("RentEmitterV6", [f.rent.address, f.ledger.address, f.launch]);
    await f.rent.write.transfer([emitter.address, parseEther("400000000")]);
    const week = await f.ledger.read.weekOf([BigInt(await f.time.time.latest())]);
    const end = await f.ledger.read.weekEnd([week]);
    await assert.rejects(f.vault.write.checkpointWeek([week, 100n]));
    await f.time.time.increaseTo(end);
    await f.vault.write.checkpointWeek([week, 1n]);
    assert.equal(await f.ledger.read.sealedWeek([week]), false);
    await f.vault.write.checkpointWeek([week, 1n]);
    assert.equal(await f.ledger.read.sealedWeek([week]), true);
    for (let w = 0n; w <= week; ++w) {
      if (!(await f.ledger.read.sealedWeek([w]))) await f.vault.write.checkpointWeek([w, 100n]);
      await emitter.write.finalizeWeek();
    }
    assert.equal(await emitter.read.emission([999_999n * 1_000_000n, 2n * 1_000_000n]), parseEther("150"));
    await assert.rejects(emitter.write.claim([week, f.alice.account.address], { account: f.alice.account }));
    await f.time.time.increaseTo(f.launch + 14n * 86400n);
    const before = await f.rent.read.balanceOf([f.alice.account.address]);
    await emitter.write.claim([week, f.alice.account.address], { account: f.alice.account });
    assert.ok(await f.rent.read.balanceOf([f.alice.account.address]) > before);
    await assert.rejects(emitter.write.claim([week, f.alice.account.address], { account: f.alice.account }));
  });

  it("has live artwork and independent guardian scopes without blocking refunds", async () => {
    const f = await fixture(); const id = await f.mintLight();
    const uri = await f.deed.read.tokenURI([id]);
    const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
    assert.equal(json.attributes.find((a: { trait_type: string }) => a.trait_type === "price").value, 40);
    const svg = Buffer.from(json.image.split(",")[1], "base64").toString();
    assert.match(svg, /DEEDZ PROTOCOL TERMINAL/); assert.match(svg, /LIT DEED/);
    assert.match(svg, /RENT TIME LEFT: \d{2}d : \d{2}h : \d{2}m/);
    await f.deed.write.setGuardian([f.bob.account.address]);
    await f.deed.write.setPause([identity("buy"), true], { account: f.bob.account });
    await assert.rejects(f.deed.write.setPause([identity("buy"), false], { account: f.bob.account }));
    await f.deed.write.darken([id], { account: f.alice.account });
    const refund = await f.vault.read.refunds([f.alice.account.address]); assert.ok(refund > 0n);
    await f.vault.write.claimRefund([f.alice.account.address], { account: f.alice.account });
    assert.equal(await f.vault.read.refunds([f.alice.account.address]), 0n);
    const dark = JSON.parse(Buffer.from((await f.deed.read.tokenURI([id])).split(",")[1], "base64").toString());
    assert.doesNotMatch(Buffer.from(dark.image.split(",")[1], "base64").toString(), /Always for sale/);
  });
});
