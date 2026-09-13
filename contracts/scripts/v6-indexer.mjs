import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, decodeEventLog } from "viem";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifest = JSON.parse(await readFile(resolve(root, process.env.V6_MANIFEST ?? "deployments/robinhood-testnet-v6-dev.json"), "utf8"));
const rpc = process.env.V6_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com";
const client = createPublicClient({ transport: http(rpc, { timeout: 30_000, retryCount: 2 }) });
const chainId = await client.getChainId();
if (chainId !== manifest.chainId) throw new Error("Indexer chain does not match manifest");
const deed = manifest.contracts.deed.toLowerCase();
const output = resolve(root, ".data/v6-index.json");
const deploymentBlock = BigInt(manifest.deployedAtBlock);
const confirmations = BigInt(process.env.V6_CONFIRMATIONS ?? "12");
const latest = await client.getBlockNumber();
const target = latest > confirmations ? latest - confirmations : 0n;
const events = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
  "event DarkMinted(bytes32 indexed ticker,uint256 indexed tokenId,address indexed owner,uint16 serial)",
  "event LitUp(bytes32 indexed ticker,uint256 indexed tokenId,address indexed owner,uint256 priceUsd6)",
  "event Bought(bytes32 indexed ticker,uint256 indexed tokenId,address indexed seller,address buyer,uint256 paidPriceUsd6,uint256 newPriceUsd6)",
  "event PriceScheduled(uint256 indexed tokenId,uint256 oldPriceUsd6,uint256 newPriceUsd6,uint64 effectiveAt)",
  "event RentToppedUp(uint256 indexed tokenId,address indexed owner,uint256 amount)",
  "event Darkened(uint256 indexed tokenId,address indexed owner,bool lapsed)",
  "event Fused(uint256 indexed survivor,uint256 indexed burned)",
]);
const empty = () => ({ version: 1, chainId, deed, indexedThrough: (deploymentBlock - 1n).toString(), blockHash: null, owners: {}, tokens: {}, events: [], updatedAt: null });
let state = empty();
try {
  const saved = JSON.parse(await readFile(output, "utf8"));
  if (saved.chainId === chainId && saved.deed === deed && saved.version === 1) {
    const prior = BigInt(saved.indexedThrough);
    if (prior < deploymentBlock || (prior <= target && (await client.getBlock({ blockNumber: prior })).hash === saved.blockHash)) state = saved;
    else console.log("Confirmed-chain mismatch; rebuilding the event index.");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(dirname(output), { recursive: true });
const range = BigInt(process.env.V6_LOG_RANGE ?? "2000");
if (range < 1n || range > 10_000n) throw new Error("V6_LOG_RANGE must be 1..10000");
for (let from = BigInt(state.indexedThrough) + 1n; from <= target; from += range) {
  const to = from + range - 1n < target ? from + range - 1n : target;
  const logs = await client.getLogs({ address: deed, fromBlock: from, toBlock: to });
  logs.sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
  for (const log of logs) {
    let decoded;
    try { decoded = decodeEventLog({ abi: events, data: log.data, topics: log.topics }); } catch { continue; }
    const args = decoded.args;
    const id = args.tokenId?.toString();
    if (decoded.eventName === "Transfer") {
      if (args.to === "0x0000000000000000000000000000000000000000") delete state.owners[id];
      else state.owners[id] = args.to.toLowerCase();
    }
    if (decoded.eventName === "DarkMinted") state.tokens[id] = { ticker: args.ticker, serial: args.serial };
    state.events.push({ event: decoded.eventName, block: log.blockNumber.toString(), hash: log.transactionHash, index: log.logIndex,
      args: JSON.parse(JSON.stringify(args, (_, value) => typeof value === "bigint" ? value.toString() : value)) });
  }
  const block = await client.getBlock({ blockNumber: to });
  state.indexedThrough = to.toString(); state.blockHash = block.hash; state.updatedAt = new Date().toISOString();
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state)); await rename(temporary, output);
  console.log(`Indexed through ${to}; ${Object.keys(state.owners).length} owned Deeds.`);
}
