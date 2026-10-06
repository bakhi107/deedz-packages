// @ts-nocheck
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { createPublicClient, http, parseAbi, parseEther, stringToHex, maxUint256, getAddress } from "viem";

const config = JSON.parse(readFileSync("config/robinhood-eth-usd.json", "utf8"));
const routes = JSON.parse(readFileSync("config/robinhood-stock-routes.json", "utf8"));
const report = { status: "running", sourceChainId: config.chainId, localChainId: 31337, checks: [], limitations: [
  "Only local fork contracts are deployed; the real feed proxy and aggregator are copied unchanged.",
  "No live deployment or signed mainnet transaction is performed.",
  "Robinhood is not in Chainlink's published sequencer uptime-feed list. Dedicated sequencer outage protection is not configured or verified.",
  "The existing treasury rejects prices older than 24 hours. At the feed's 24-hour heartbeat, update delays can temporarily block price-dependent operations.",
], sourceHashes: Object.fromEntries(["contracts/v6/OracleV6.sol", "contracts/final/RentTreasury.sol", "contracts/final/Deed.sol", "scripts/stock/oracle-fork-test.ts", "config/robinhood-eth-usd.json"].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])) };
const save = () => { mkdirSync("deployments/oracle-fork", { recursive: true }); writeFileSync("deployments/oracle-fork/result.json", JSON.stringify(report, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n"); };
const pass = message => { report.checks.push(message); console.log("PASS " + message); save(); };
let connection;
try {
  const remote = createPublicClient({ transport: http(process.env.STOCK_FORK_RPC ?? config.rpcUrl) });
  assert.equal(await remote.getChainId(), config.chainId);
  connection = await network.create({ network: "stockFork" });
  const request = connection.provider.request.bind(connection.provider);
  connection.provider.request = async payload => {
    if (["eth_sendTransaction", "eth_sendRawTransaction"].includes(payload.method)) {
      const block = await request({ method: "eth_getBlockByNumber", params: ["latest", false] });
      await request({ method: "evm_setNextBlockTimestamp", params: [Number(BigInt(block.timestamp)) + 1] });
    }
    return request(payload);
  };
  const { viem, networkHelpers: nh } = connection;
  const client = await viem.getPublicClient(); assert.equal(await client.getChainId(), 31337);
  const metadata = await connection.provider.request({ method: "hardhat_metadata" });
  assert.equal(Number(metadata.forkedNetwork.chainId), config.chainId); report.sourceBlock = metadata.forkedNetwork.forkBlockNumber;
  const [owner, holder, buyer, team] = await viem.getWalletClients();
  const address = owner.account.address;
  const mined = async action => { const hash = await action; const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, "success"); return receipt; };
  const abi = parseAbi(["function description() view returns (string)", "function decimals() view returns (uint8)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
  const read = functionName => client.readContract({ address: config.feedProxy, abi, functionName });
  const [description, decimals, round] = await Promise.all([read("description"), read("decimals"), read("latestRoundData")]);
  assert.equal(description, config.description); assert.equal(decimals, config.decimals);
  assert.ok(round[0] > 0n && round[1] > 0n && round[3] > 0n && round[4] >= round[0]);
  const oracle = await viem.deployContract(config.adapterArtifact, [config.feedProxy]);
  const [price, updatedAt] = await oracle.read.latestPriceUsd6();
  assert.equal(price, round[1] / 100n); assert.equal(updatedAt, round[3]);
  report.feed = { proxy: config.feedProxy, description, decimals, roundId: round[0], rawAnswer: round[1], priceUsd6: price, updatedAt, ageSeconds: (await client.getBlock()).timestamp - updatedAt };
  assert.ok(report.feed.ageSeconds <= BigInt(config.treasuryMaxAgeSeconds));
  pass("Real Robinhood ETH/USD proxy is readable by the production adapter; exact decimals and original timestamp verified");

  const rent = await viem.deployContract("RentToken", [address]);
  const treasury = await viem.deployContract("RentTreasury", [address, address, team.account.address, oracle.address]);
  const rewards = await viem.deployContract("StockRewards", [address, address]);
  const liquidity = await viem.deployContract("ProtocolLiquidityManager", [address, address]);
  const exchange = await viem.deployContract("PonsStockAdapter", [address, routes.factory, routes.weth, routes.usdg, rent.address]);
  const fees = await viem.deployContract("FeeProcessor", [address, address, rewards.address, exchange.address, liquidity.address, team.account.address]);
  const deed = await viem.deployContract("contracts/final/Deed.sol:Deed", [address, rent.address, treasury.address, fees.address]);
  await mined(treasury.write.configureDeed([deed.address])); await mined(fees.write.setFeeSource([deed.address, true]));
  assert.equal(getAddress(await treasury.read.priceFeed()), getAddress(oracle.address));
  report.contracts = { oracle: oracle.address, treasury: treasury.address, deed: deed.address, fees: fees.address };
  const ceilEth = usd => (usd * 10n ** 18n + price - 1n) / price;
  for (const usd of [5_000_000n, 100_000_000n, 123_456_789n, 1000000_000000n]) assert.equal(await treasury.read.usdToEth([usd]), ceilEth(usd));
  const daily = await treasury.read.dailyRentWei([100_000_000n]); assert.equal(daily, ceilEth(300000n));
  assert.equal(await treasury.read.MAX_ORACLE_AGE(), BigInt(config.treasuryMaxAgeSeconds));
  pass("Final treasury converts valuations and 0.3% daily rent using the actual Chainlink answer, with upward ETH rounding");

  const ticker = stringToHex("NVDA", { size: 32 });
  await mined(rent.write.transfer([holder.account.address, parseEther("100000")]));
  await mined(rent.write.approve([deed.address, maxUint256], { account: holder.account }));
  await mined(deed.write.mint([ticker], { account: holder.account }));
  const supply = await rent.read.totalSupply();
  await assert.rejects(deed.write.light([1n, 100_000_000n], { account: holder.account, value: daily * 7n - 1n }));
  assert.equal(await rent.read.totalSupply(), supply);
  await mined(deed.write.light([1n, 100_000_000n], { account: holder.account, value: daily * 7n }));
  assert.equal(supply - await rent.read.totalSupply(), parseEther("25000")); assert.equal(Number(await deed.read.stateOf([1n])), 1);
  await mined(deed.write.setPrice([1n, 120_000_000n], { account: holder.account }));
  assert.equal(await treasury.read.dailyRate([1n]), ceilEth(360000n));
  await mined(deed.write.topUpRent([1n], { account: holder.account, value: daily }));
  report.rentExample = { valuationUsd6: 100_000_000n, dailyRentWei: daily, sevenDayDepositWei: daily * 7n };
  pass("NFT lighting, exact seven-day funding, RENT burn, valuation changes and top-ups succeed with the production oracle");

  const sale = ceilEth(120_000_000n), saleFee = sale * 500n / 10000n;
  const newDeposit = await treasury.read.dailyRentWei([80_000_000n]) * 7n;
  await mined(deed.write.buy([1n, 80_000_000n], { account: buyer.account, value: sale + saleFee + newDeposit }));
  assert.equal(getAddress(await deed.read.ownerOf([1n])), getAddress(buyer.account.address));
  assert.equal(await deed.read.saleProceeds([holder.account.address]), sale);
  assert.equal(await fees.read.teamBalance(), saleFee);
  assert.ok(await treasury.read.teamBalance() > 0n);
  report.purchaseExample = { valuationUsd6: 120_000_000n, salePriceWei: sale, feeWei: saleFee, buyerRunwayWei: newDeposit };
  pass("NFT purchase uses the live-feed valuation and buyer runway; seller proceeds and existing team fee are correctly accounted");

  await mined(deed.write.mint([ticker], { account: holder.account }));
  const savedPosition = await treasury.read.position([1n]), savedSupply = await rent.read.totalSupply();
  await nh.time.increaseTo(updatedAt + BigInt(config.treasuryMaxAgeSeconds) + 1n);
  assert.equal((await oracle.read.latestPriceUsd6())[1], updatedAt);
  await assert.rejects(treasury.read.usdToEth([100_000_000n]), /Oracle unavailable/);
  await assert.rejects(deed.write.light([2n, 100_000_000n], { account: holder.account, value: daily * 7n }), /Oracle unavailable/);
  await assert.rejects(deed.write.setPrice([1n, 90_000_000n], { account: buyer.account }), /Oracle unavailable/);
  await assert.rejects(deed.write.topUpRent([1n], { account: buyer.account, value: daily }), /Oracle unavailable/);
  await assert.rejects(deed.write.buy([1n, 80_000_000n], { account: holder.account, value: parseEther("1") }), /Oracle unavailable/);
  assert.equal(await rent.read.totalSupply(), savedSupply); assert.deepEqual(await treasury.read.position([1n]), savedPosition);
  assert.equal(getAddress(await deed.read.ownerOf([1n])), getAddress(buyer.account.address));
  assert.equal((await treasury.read.preview([1n])).length, 3);
  pass("Frozen real-feed timestamp becomes stale after 24 hours; price-dependent actions revert atomically without burning RENT or changing ownership");
  const recipientBefore = await client.getBalance({ address });
  await mined(deed.write.claimSaleProceeds([address], { account: holder.account }));
  assert.equal(await client.getBalance({ address }), recipientBefore + sale);
  assert.equal(await deed.read.saleProceeds([holder.account.address]), 0n);
  pass("Already-earned seller proceeds remain withdrawable while the price feed is stale");
  report.status = "passed"; save();
} catch (error) { report.status = "failed"; report.error = error.shortMessage ?? error.message; save(); throw error; }
finally { await connection?.close(); }
