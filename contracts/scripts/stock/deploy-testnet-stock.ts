// @ts-nocheck
// Fresh public testnet suite; mocks are explicitly recorded under testAssets.
import { artifacts } from "hardhat";
import { createPublicClient, createWalletClient, http, getContract, getAddress, decodeEventLog, encodeDeployData, encodeFunctionData, keccak256, getContractAddress, numberToHex, concatHex, encodeAbiParameters, zeroAddress, zeroHash, maxUint256, parseEther, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { waitForKeeperReceipt } from "../testnet-keeper-state.mjs";

const require = createRequire(import.meta.url);
const factoryArtifact = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const poolArtifact = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const file = "deployments/robinhood-testnet-stock.json";
const rpcUrl = "https://rpc.testnet.chain.robinhood.com";
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const client = createPublicClient({ cacheTime: 0, transport: http(rpcUrl, { timeout: 30_000, retryCount: 2 }) });
const wallet = createWalletClient({ account, transport: http(rpcUrl) });
if (await client.getChainId() !== 46630) throw Error("Testnet only");
if (process.env.DEEDZ_DEPLOY_TESTNET !== "1") throw Error("Set DEEDZ_DEPLOY_TESTNET=1");
const owner = getAddress(account.address);
const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {
  chainId: 46630, rpcUrl, testnet: true, status: "deploying", deployer: owner, keeper: owner, team: owner,
  limitations: ["Test stock tokens and synthetic ETH/USD feed have no monetary value.", "V3 pool bytecode is real; this is a separate test venue, not the mainnet Pons venue.", "Existing NFTs and balances remain on the previous deployment."],
  contracts: {}, infrastructure: {}, testAssets: {}, stocks: [], operations: {},
};
if (state.chainId !== 46630 || state.deployer !== owner) throw Error("Deployment identity mismatch");
const save = () => { mkdirSync("deployments", { recursive: true }); writeFileSync(file + ".tmp", JSON.stringify(state, null, 2) + "\n"); renameSync(file + ".tmp", file); };
save();
if (await client.getBalance({ address: owner }) < parseEther("0.012")) throw Error("At least 0.012 test ETH needed for initial liquidity and gas");

async function transaction(label, request) {
  let operation = state.operations[label];
  if (!operation) {
    const prepared = await wallet.prepareTransactionRequest({ ...request, account, chain: null });
    const signed = await wallet.signTransaction(prepared);
    operation = { hash: keccak256(signed), nonce: prepared.nonce, status: "prepared" };
    state.operations[label] = operation; save();
    await wallet.sendRawTransaction({ serializedTransaction: signed });
  }
  const receipt = await waitForKeeperReceipt(client, operation.hash);
  if (receipt.status !== "success") throw Error(label + " reverted: " + operation.hash);
  operation.status = "confirmed"; operation.blockNumber = receipt.blockNumber.toString();
  if (receipt.contractAddress) operation.contractAddress = getAddress(receipt.contractAddress);
  save(); console.log(label + " " + operation.hash);
  return receipt;
}
async function deploy(key, name, args = [], artifact) {
  artifact ??= await artifacts.readArtifact(name);
  if (!state.contracts[key]) {
    const receipt = await transaction("deploy:" + key, { data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }) });
    state.contracts[key] = getAddress(receipt.contractAddress); save();
  }
  const address = state.contracts[key];
  if (!await client.getCode({ address })) throw Error("Missing deployed code: " + key);
  return getContract({ address, abi: artifact.abi, client });
}
const write = (label, contract, functionName, args = [], value = 0n) => transaction(label, { to: contract.address, data: encodeFunctionData({ abi: contract.abi, functionName, args }), value });

const rent = await deploy("rent", "RentToken", [owner]);
const weth = await deploy("weth", "TestnetWrappedEther");
const usdg = await deploy("usdg", "TestStockToken", ["tUSDG", owner]);
const factory = await deploy("factory", "", [], factoryArtifact);
const seeder = await deploy("seeder", "TestnetV3Seeder", [owner]);
const feed = await deploy("testFeed", "TestnetChainlinkFeed");
const oracle = await deploy("oracle", "EthUsdOracleV6", [feed.address]);
const adapter = await deploy("adapter", "PonsStockAdapter", [owner, factory.address, weth.address, usdg.address, rent.address]);
const treasury = await deploy("treasury", "RentTreasury", [owner, owner, owner, oracle.address]);
const rewards = await deploy("rewards", "StockRewards", [owner, owner]);
const liquidity = await deploy("liquidity", "ProtocolLiquidityManager", [owner, owner]);
const processor = await deploy("processor", "FeeProcessor", [owner, owner, rewards.address, adapter.address, liquidity.address, owner]);
const settlement = await deploy("settlement", "SundaySettlement", [owner, owner, treasury.address, rewards.address, rent.address, adapter.address, liquidity.address, owner]);
const deed = await deploy("deed", "contracts/final/Deed.sol:Deed", [owner, rent.address, treasury.address, processor.address]);
const faucet = await deploy("faucet", "TestRentFaucet", [rent.address]);
state.contracts.art = await deed.read.art();
state.testAssets = { feed: feed.address, weth: weth.address, usdg: usdg.address, factory: factory.address, stocks: {} }; save();

await write("configure:deed", treasury, "configureDeed", [deed.address]);
await write("configure:settlement", treasury, "configureSettlement", [settlement.address]);
await write("authorize:processor", rewards, "setProcessor", [processor.address, true]);
await write("authorize:settlement", rewards, "setProcessor", [settlement.address, true]);
await write("authorize:adapter-processor", adapter, "setBuyer", [processor.address, true]);
await write("authorize:adapter-settlement", adapter, "setBuyer", [settlement.address, true]);
await write("authorize:deed-fees", processor, "setFeeSource", [deed.address, true]);
await write("test:weth-funding", weth, "deposit", [], parseEther("0.005"));
await write("test:usdg-funding", usdg, "mint", [owner, parseEther("10")]);
await write("approve:weth-seeder", weth, "approve", [seeder.address, maxUint256]);
await write("approve:usdg-seeder", usdg, "approve", [seeder.address, maxUint256]);
async function pool(label, a, b, amount) {
  let address = await factory.read.getPool([a, b, 3000]);
  if (address === zeroAddress || state.operations["pool:" + label]) {
    const receipt = await write("pool:" + label, factory, "createPool", [a, b, 3000]);
    const log = receipt.logs.find(l => getAddress(l.address) === getAddress(factory.address));
    if (!log) throw Error("Missing PoolCreated event: " + label);
    address = decodeEventLog({ abi: factoryArtifact.abi, data: log.data, topics: log.topics }).args.pool;
  }
  if (address === zeroAddress || !await client.getCode({ address })) throw Error("Missing pool code: " + label);
  const p = getContract({ address, abi: poolArtifact.abi, client });
  if ((await p.read.slot0())[0] === 0n) await write("initialize:" + label + ":" + address, p, "initialize", [2n ** 96n]);
  await write("seed:" + label, seeder, "seed", [p.address, amount]);
  return p.address;
}
const fundingPool = await pool("funding", weth.address, usdg.address, 2n * 10n ** 15n);
await write("configure:funding-pool", adapter, "setFundingPool", [fundingPool]);
state.infrastructure.fundingPool = fundingPool;
const tickers = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "NFLX", "AMD", "COIN"];
for (let i = 0; i < tickers.length; i++) {
  const symbol = tickers[i], ticker = stringToHex(symbol, { size: 32 });
  const stock = await deploy("stock" + symbol, "TestStockToken", [symbol, owner]);
  await write("mint:" + symbol, stock, "mint", [owner, parseEther("1000000")]);
  await write("approve:" + symbol, stock, "approve", [seeder.address, maxUint256]);
  const viaUSDG = i % 2 === 1;
  const p = await pool(symbol, stock.address, viaUSDG ? usdg.address : weth.address, 5n * 10n ** 14n);
  await write("route:" + symbol, adapter, "configureStock", [ticker, stock.address, p, viaUSDG]);
  await write("reward-stock:" + symbol, rewards, "configureStock", [ticker, stock.address]);
  state.stocks[i] = { ticker: symbol, token: stock.address, pool: p, viaUSDG, testAsset: true };
  state.testAssets.stocks[symbol] = stock.address; save();
}

const managerAddress = getAddress(process.env.V6_POOL_MANAGER), stateView = getAddress(process.env.V6_STATE_VIEW), create2 = getAddress(process.env.V6_CREATE2_FACTORY), seedRouter = getAddress(process.env.V6_LIQUIDITY_ROUTER);
for (const address of [managerAddress, stateView, create2, seedRouter]) if (!await client.getCode({ address })) throw Error("Missing V4 infrastructure " + address);
const hookArtifact = await artifacts.readArtifact("TradingHook");
const initCode = encodeDeployData({ abi: hookArtifact.abi, bytecode: hookArtifact.bytecode, args: [managerAddress, owner] });
let salt, hook, nonce = 0n;
do { salt = numberToHex(nonce++, { size: 32 }); hook = getContractAddress({ opcode: "CREATE2", from: create2, salt, bytecode: initCode }); } while ((BigInt(hook) & 16383n) !== 128n);
if (!await client.getCode({ address: hook })) await transaction("deploy:hook", { to: create2, data: concatHex([salt, initCode]) });
state.contracts.hook = hook; save();
const router = await deploy("router", "TradingRouter", [managerAddress, rent.address, hook, processor.address]);
const key = { currency0: zeroAddress, currency1: rent.address, fee: 0, tickSpacing: 60, hooks: hook };
const hookContract = getContract({ address: hook, abi: hookArtifact.abi, client });
await write("configure:hook", hookContract, "configurePool", [key, router.address]);
const manager = getContract({ address: managerAddress, abi: (await artifacts.readArtifact("V4PoolManager")).abi, client });
const v4Seeder = getContract({ address: seedRouter, abi: (await artifacts.readArtifact("V4LiquidityRouter")).abi, client });
await write("initialize:rent-pool", manager, "initialize", [key, 1000n * 2n ** 96n]);
await write("approve:rent-liquidity", rent, "approve", [seedRouter, maxUint256]);
await write("seed:rent-pool", v4Seeder, "modifyLiquidity", [key, { tickLower: -887220, tickUpper: 887220, liquidityDelta: 2n * 10n ** 15n, salt: zeroHash }, "0x"], parseEther("0.002"));
await write("authorize:router-fees", processor, "setFeeSource", [router.address, true]);
await write("configure:liquidity-router", liquidity, "configureRouter", [router.address]);
await write("configure:adapter-rent-router", adapter, "setRentRouter", [router.address]);
await write("fund:faucet", rent, "transfer", [faucet.address, parseEther("10000000")]);
await write("fund:protocol-liquidity", rent, "transfer", [liquidity.address, parseEther("100000")]);
await write("revoke:owner-reward-funding", rewards, "setProcessor", [owner, false]);
const poolId = keccak256(encodeAbiParameters([{ type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }], [key]));
state.infrastructure = { ...state.infrastructure, poolManager: managerAddress, stateView, create2, liquidityRouter: seedRouter };
state.pool = { id: poolId, fee: 0, tickSpacing: 60 };
state.deployedAtBlock = state.operations["deploy:deed"].blockNumber;
state.firstCycleReadyAt = (await processor.read.lastCycleAt() + await processor.read.INTERVAL()).toString();
state.status = "deployed"; state.completedAt = new Date().toISOString(); save();
console.log(JSON.stringify({ status: state.status, contracts: state.contracts, firstCycleReadyAt: state.firstCycleReadyAt }, null, 2));
