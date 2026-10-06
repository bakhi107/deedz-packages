// @ts-nocheck
// Small, explicit testnet-only sample. Every submitted hash is saved before broadcast.
import { artifacts } from "hardhat";
import { createPublicClient, createWalletClient, http, getContract, getAddress, encodeFunctionData, keccak256, parseEther, stringToHex, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { waitForKeeperReceipt, persistKeeperData } from "../testnet-keeper-state.mjs";

const m = JSON.parse(readFileSync("deployments/robinhood-testnet-stock.json", "utf8"));
if (m.chainId !== 46630 || !m.testnet || m.status !== "deployed") throw Error("Completed testnet suite required");
if (process.env.DEEDZ_TESTNET_SMOKE !== "1") throw Error("Set DEEDZ_TESTNET_SMOKE=1");
const client = createPublicClient({ cacheTime: 0, transport: http(m.rpcUrl) });
if (await client.getChainId() !== 46630) throw Error("Testnet only");
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
if (getAddress(account.address) !== getAddress(m.keeper)) throw Error("Expected test keeper");
const wallet = createWalletClient({ account, transport: http(m.rpcUrl) });
const path = "keeper-data/stock-testnet/smoke.json";
const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { chainId: 46630, deed: m.contracts.deed, account: account.address, operations: {} };
if (state.deed !== m.contracts.deed || getAddress(state.account) !== getAddress(account.address)) throw Error("Sample identity mismatch");
const save = () => { mkdirSync("keeper-data/stock-testnet", { recursive: true }); writeFileSync(path + ".tmp", JSON.stringify(state, null, 2) + "\n"); renameSync(path + ".tmp", path); persistKeeperData(); };
const attach = async (name, key) => getContract({ address: m.contracts[key], abi: (await artifacts.readArtifact(name)).abi, client });
const deed = await attach("contracts/final/Deed.sol:Deed", "deed"), treasury = await attach("RentTreasury", "treasury"), rent = await attach("RentToken", "rent"), router = await attach("TradingRouter", "router"), rewards = await attach("StockRewards", "rewards"), processor = await attach("FeeProcessor", "processor");
async function send(label, contract, functionName, args = [], value = 0n) {
  if (!state.operations[label]) {
    const prepared = await wallet.prepareTransactionRequest({ account, chain: null, to: contract.address, data: encodeFunctionData({ abi: contract.abi, functionName, args }), value });
    const signed = await wallet.signTransaction(prepared);
    state.operations[label] = { hash: keccak256(signed), nonce: prepared.nonce }; save();
    await wallet.sendRawTransaction({ serializedTransaction: signed });
  }
  const receipt = await waitForKeeperReceipt(client, state.operations[label].hash);
  if (receipt.status !== "success") throw Error("Sample transaction reverted: " + label);
  state.operations[label].confirmed = true; save(); console.log(label + " " + receipt.transactionHash); return receipt;
}
if (process.env.DEEDZ_SMOKE_PHASE === "prepare") {
  const receipt = await send("mint", deed, "mint", [stringToHex("NVDA", { size: 32 })]);
  const event = receipt.logs.map(log => { try { return decodeEventLog({ abi: deed.abi, data: log.data, topics: log.topics }); } catch { return null; } }).find(log => log?.eventName === "DormantMinted");
  if (!event) throw Error("Missing minted token event");
  state.tokenId = event.args.tokenId.toString(); save();
  await send("approve-light", rent, "approve", [deed.address, parseEther("25000")]);
  await send("light", deed, "light", [BigInt(state.tokenId), 5_000_000n], await treasury.read.dailyRentWei([5_000_000n]) * 7n);
  await send("trade", router, "swapExactInputEthForRent", [1n, (await client.getBlock()).timestamp + 120n], parseEther("0.00002"));
  state.status = "waiting-for-cycle"; save();
} else if (process.env.DEEDZ_SMOKE_PHASE === "verify") {
  if (!state.tokenId) throw Error("Prepare sample first");
  const id = BigInt(state.tokenId), available = await rewards.read.claimableStock([account.address, id]);
  const claimed = await rewards.read.claimedStock([account.address, id]);
  if (claimed === 0n && available > 0n) {
    await send("claim", rewards, "claimStockRewards", [id]);
    if (await rewards.read.claimedStock([account.address, id]) === 0n) throw Error("Claim not credited");
    state.status = "claimed"; save();
  } else if (claimed > 0n) { state.status = "claimed"; save(); }
  else console.log("PENDING: no sample credit yet; the keeper must complete the first three-hour cycle");
} else throw Error("Set phase prepare or verify");
console.log(JSON.stringify({ status: state.status, deed: state.deed, tokenId: state.tokenId, rewards: rewards.address, firstCycleReadyAt: (await processor.read.lastCycleAt() + await processor.read.INTERVAL()).toString() }));
