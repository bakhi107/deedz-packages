// @ts-nocheck
import assert from "node:assert/strict";
import { network } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEther, stringToHex, getAddress } from "viem";
import { planCycle, planSunday, completedManifests, registerRewardClaims, planLiquidity, eligibleGroups } from "./keeper.js";

const manifest = JSON.parse(readFileSync("deployments/robinhood-testnet-stock.json", "utf8"));
if (manifest.chainId !== 46630 || manifest.status !== "deployed") throw Error("Expected completed testnet suite");
const connection = await network.create({ network: "stockTestnetFork" });
const { viem, networkHelpers: nh } = connection;
const client = await viem.getPublicClient();
assert.equal(await client.getChainId(), 31337);
const metadata = await connection.provider.request({ method: "hardhat_metadata" });
assert.equal(Number(metadata.forkedNetwork.chainId), 46630);
const report = { status: "running", sourceChainId: 46630, localChainId: 31337, sourceBlock: metadata.forkedNetwork.forkBlockNumber, contracts: manifest.contracts, checks: [], purchases: [], sales: [] };
const save = () => writeFileSync("deployments/testnet-stock-fork-verification.json", JSON.stringify(report, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");
const pass = text => { report.checks.push(text); console.log("PASS " + text); save(); };
const request = connection.provider.request.bind(connection.provider);
connection.provider.request = async payload => {
  if (["eth_sendTransaction", "eth_sendRawTransaction"].includes(payload.method)) {
    const block = await request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    await request({ method: "evm_setNextBlockTimestamp", params: [Number(BigInt(block.timestamp)) + 1] });
  }
  return request(payload);
};
try {
  await nh.impersonateAccount(manifest.deployer); await nh.setBalance(manifest.deployer, parseEther("10"));
  const owner = await viem.getWalletClient(manifest.deployer);
  const [holder, buyer] = await viem.getWalletClients();
  const attach = (name, key) => viem.getContractAt(name, manifest.contracts[key]);
  const rent = await attach("RentToken", "rent"), deed = await attach("contracts/final/Deed.sol:Deed", "deed"), treasury = await attach("RentTreasury", "treasury"), rewards = await attach("StockRewards", "rewards"), processor = await attach("FeeProcessor", "processor"), adapter = await attach("PonsStockAdapter", "adapter"), settlement = await attach("SundaySettlement", "settlement"), router = await attach("TradingRouter", "router"), liquidity = await attach("ProtocolLiquidityManager", "liquidity"), oracle = await attach("EthUsdOracleV6", "oracle");
  const send = async (c, name, args = [], account = owner.account, value = 0n) => {
    const tx = await c.write[name](args, { account, value });
    assert.equal((await client.waitForTransactionReceipt({ hash: tx })).status, "success"); return tx;
  };
  assert.equal(await rewards.read.claimInterfaceVersion(), 1n);
  assert.equal(await processor.read.INTERVAL(), 10800n);
  assert.equal(getAddress(await treasury.read.priceFeed()), getAddress(oracle.address));
  assert.equal((await oracle.read.latestPriceUsd6())[0], 2_500_000_000n);
  await send(rent, "transfer", [holder.account.address, parseEther("500000")]);
  await send(rent, "approve", [deed.address, parseEther("500000")], holder.account);
  const ids = [];
  for (const s of manifest.stocks) {
    await send(deed, "mint", [stringToHex(s.ticker, { size: 32 })], holder.account);
    const id = await deed.read.totalMinted(); ids.push(id);
    assert.equal(await deed.read.stateOf([id]), 0);
    const before = await rent.read.totalSupply();
    await send(deed, "light", [id, 5_000_000n], holder.account, await treasury.read.dailyRentWei([5_000_000n]) * 7n);
    assert.equal(before - await rent.read.totalSupply(), parseEther("25000"));
    assert.equal(await deed.read.stateOf([id]), 1);
  }
  await send(deed, "topUpRent", [ids[0]], holder.account, parseEther("0.0001"));
  await send(deed, "setPrice", [ids[0], 6_000_000n], holder.account);
  assert.ok((await deed.read.tokenURI([ids[0]])).startsWith("data:application/json"));
  pass("All ten deployed clans mint/light; exact RENT burns, oracle conversion, top-up, repricing and NFT metadata");

  const feeBefore = await processor.read.queuedTradingFees();
  await send(router, "swapExactInputEthForRent", [1n, (await client.getBlock()).timestamp + 120n], holder.account, parseEther("0.00002"));
  assert.equal(await processor.read.queuedTradingFees() - feeBefore, parseEther("0.000001"));
  await send(rent, "approve", [router.address, parseEther("0.01")], holder.account);
  await send(router, "swapExactInputRentForEth", [parseEther("0.01"), 1n, (await client.getBlock()).timestamp + 120n], holder.account);
  const readyAt = await processor.read.lastCycleAt() + await processor.read.INTERVAL();
  if ((await client.getBlock()).timestamp <= readyAt) await nh.time.increaseTo(readyAt + 1n);
  const plan = await planCycle(client, deed, processor, rewards, adapter); assert.ok(!plan.skip, plan.skip);
  await assert.rejects(processor.write.processStockCycle(plan.args, { account: buyer.account }));
  const fees = await processor.read.queuedTradingFees(), teamBefore = await processor.read.teamBalance(), lpBefore = await client.getBalance({ address: liquidity.address });
  const tx = await send(processor, "processStockCycle", plan.args);
  assert.equal(await processor.read.teamBalance() - teamBefore, fees - fees * 70n / 100n - fees * 20n / 100n);
  assert.equal(await client.getBalance({ address: liquidity.address }) - lpBefore, fees * 20n / 100n);
  const batches = await completedManifests(rewards, plan, tx);
  assert.equal(batches.length, 10); report.purchases = batches.map(b => ({ ticker: b.ticker, funded: b.funded }));
  await registerRewardClaims(rewards, batches, (c, name, args) => send(c, name, args));
  await registerRewardClaims(rewards, batches, async () => { throw Error("Registration replay"); });
  pass("V4 buys/sells collect 5%; three-hour stock cycle buys all ten tokens through V3 with exact 70/20/10 and idempotent credit registration");

  const sale = await treasury.read.usdToEth([6_000_000n]);
  const deposit = await treasury.read.dailyRentWei([5_000_000n]) * 7n;
  await send(deed, "buy", [ids[0], 5_000_000n], buyer.account, sale + sale * 5n / 100n + deposit);
  assert.equal(getAddress(await deed.read.ownerOf([ids[0]])), getAddress(buyer.account.address));
  assert.equal(await deed.read.saleProceeds([holder.account.address]), sale);
  await send(deed, "claimSaleProceeds", [holder.account.address], holder.account);
  assert.equal(await deed.read.saleProceeds([holder.account.address]), 0n);
  await assert.rejects(rewards.write.claimStockRewards([ids[0]], { account: buyer.account }));
  for (const id of ids) {
    assert.ok(await rewards.read.claimableStock([holder.account.address, id]) > 0n);
    await send(rewards, "claimStockRewards", [id], holder.account);
    await assert.rejects(rewards.write.claimStockRewards([id], { account: holder.account }));
  }
  pass("Buyout transfers NFT and pays seller; previous holder retains earned stock; all ten single-argument claims and replay protection work");
  for (const s of manifest.stocks) {
    const stock = await viem.getContractAt("TestStockToken", s.token), amount = await stock.read.balanceOf([holder.account.address]);
    await send(stock, "approve", [adapter.address, amount], holder.account);
    const args = [stringToHex(s.ticker, { size: 32 }), amount, 1n, (await client.getBlock()).timestamp + 120n];
    const simulation = await client.simulateContract({ address: adapter.address, abi: adapter.abi, functionName: "sellStock", args, account: holder.account });
    args[2] = simulation.result * 995n / 1000n;
    await send(adapter, "sellStock", args, holder.account);
    assert.equal(await stock.read.balanceOf([holder.account.address]), 0n); report.sales.push({ ticker: s.ticker, stockIn: amount, ethOut: simulation.result });
  }
  async function reinvest() {
    const lp = await planLiquidity(client, liquidity, router, rent, owner.account.address);
    assert.ok(!lp.skip, lp.skip); await send(liquidity, "reinvest", lp.args); assert.ok(await liquidity.read.totalLiquidity() > 0n);
  }
  await reinvest(); pass("All ten stock tokens sell back to test ETH; keeper reinvests protocol liquidity");
  const week = await treasury.read.weekOf([(await client.getBlock()).timestamp]);
  await nh.time.increaseTo(await treasury.read.weekEnd([week]) + 1n);
  await send(treasury, "checkpointWeek", [week, 250n]); await send(treasury, "finalizeWeek", [week]);
  const sunday = await planSunday(client, deed, treasury, settlement, rewards, adapter, week); assert.ok(!sunday.skip, sunday.skip);
  const supplyBefore = await rent.read.totalSupply();
  const stx = await send(settlement, "settleStocks", sunday.args);
  assert.ok(await rent.read.totalSupply() < supplyBefore);
  await registerRewardClaims(rewards, await completedManifests(rewards, sunday, stx), (c, name, args) => send(c, name, args));
  await assert.rejects(settlement.write.settleStocks(sunday.args, { account: owner.account }));
  await reinvest(); pass("Sunday checkpoint, buyback/burn, jackpot credits, liquidity and duplicate-settlement rejection");
  const position = await treasury.read.preview([ids[1]]);
  await nh.time.increaseTo(position[1] + 1n); assert.equal(await deed.read.stateOf([ids[1]]), 2);
  assert.ok((await eligibleGroups(deed, await client.getBlockNumber())).some(g => g.holders.some(h => h.id === ids[1])));
  await nh.time.increaseTo(position[2] + 1n); assert.equal(await deed.read.stateOf([ids[1]]), 3);
  const burnBefore = await rent.read.totalSupply();
  await send(deed, "light", [ids[1], 5_000_000n], holder.account, await treasury.read.dailyRentWei([5_000_000n]) * 7n);
  assert.equal(burnBefore - await rent.read.totalSupply(), parseEther("25000"));
  pass("Grace eligibility, Dark exclusion and paid relighting after local time advancement");
  report.status = "passed"; save();
} catch (error) { report.status = "failed"; report.error = error.shortMessage ?? error.message; save(); throw error; }
finally { await connection.close(); }
