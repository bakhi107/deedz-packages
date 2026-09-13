// @ts-nocheck
import { network } from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress, isAddress } from "viem";

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const client = await viem.getPublicClient(); const [wallet] = await viem.getWalletClients();
const deed = await viem.getContractAt("contracts/final/Deed.sol:Deed", env("FINAL_DEED"));
const treasury = await viem.getContractAt("RentTreasury", env("FINAL_TREASURY"));
const settlement = await viem.getContractAt("SundaySettlement", env("FINAL_SETTLEMENT"));
const rewards = await viem.getContractAt("StockRewards", env("FINAL_REWARDS"));
const exchange = await viem.getContractAt("TestExchange", env("FINAL_EXCHANGE"));
if ((await treasury.read.keeper()).toLowerCase() !== wallet.account.address.toLowerCase()) throw new Error("Configured key is not the keeper");
const currentWeek = await treasury.read.weekOf([BigInt(Math.floor(Date.now() / 1000))]);
for (let week = 0n; week < currentWeek; ++week) {
  if (await settlement.read.settled([week])) continue;
  if (!await treasury.read.weekFinalized([week])) {
    const count = await treasury.read.positionCount(); let cursor = await treasury.read.checkpointCursor([week]);
    while (cursor < count) { await mined(treasury.write.checkpointWeek([week, 250n])); cursor = await treasury.read.checkpointCursor([week]); }
    await mined(treasury.write.finalizeWeek([week]));
  }
  const total = await treasury.read.distributableRentEth([week]); if (total === 0n) continue;
  const [winner] = await settlement.read.winningClan([week]); const holders = [];
  const minted = await deed.read.totalMinted(); for (let id = 1n; id <= minted; ++id) { const data = await deed.read.deedData([id]); if (data[0].toLowerCase() === winner.toLowerCase() && await deed.read.stateOf([id]) === 1) holders.push({ id, owner: await deed.read.ownerOf([id]) }); }
  if (!holders.length) throw new Error(`Week ${week}: winning clan has no Lit holders`);
  const jackpotEth = total * 20n / 100n; const rate = await exchange.read.stockPerEth([winner]); const stockTotal = jackpotEth * rate / 10n ** 18n; const batchId = await rewards.read.batchCount(); let used = 0n;
  const values = holders.map((holder, index) => { const amount = index === holders.length - 1 ? stockTotal - used : stockTotal / BigInt(holders.length); used += amount; return [batchId.toString(), holder.id.toString(), getAddress(holder.owner), amount.toString()]; });
  const tree = StandardMerkleTree.of(values, ["uint256","uint256","address","uint256"]); const claims = [...tree.entries()].map(([i,value]) => ({ batchId:value[0],tokenId:value[1],account:value[2],amount:value[3],proof:tree.getProof(i) }));
  const hash = await settlement.write.settle([week, total * 50n / 100n * await exchange.read.rentPerEth() / 10n ** 18n, stockTotal, tree.root]); await client.waitForTransactionReceipt({ hash });
  await publish({ id:batchId.toString(), ticker:winner, root:tree.root, claims, transaction:hash, createdAt:new Date().toISOString(), kind:"Sunday", week:week.toString() }); console.log(`SUNDAY_OK week=${week} ${hash}`);
}
async function mined(promise: Promise<`0x${string}`>) { const hash = await promise; const receipt = await client.waitForTransactionReceipt({ hash }); if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`); }
async function publish(batch:any) { const dir=resolve(process.cwd(),"keeper-data"), path=resolve(dir,"rewards.json"); await mkdir(dir,{recursive:true}); let history={chainId:46630,rewards:rewards.address.toLowerCase(),batches:[] as any[]}; try { const stored=JSON.parse(await readFile(path,"utf8")); if(stored.rewards===history.rewards) history=stored; } catch {} history.batches.push(batch); await writeFile(path,JSON.stringify(history,null,2)+"\n"); }
function env(name:string) { const value=process.env[name]; if(!value||!isAddress(value)) throw new Error(`${name} missing`); return getAddress(value); }
