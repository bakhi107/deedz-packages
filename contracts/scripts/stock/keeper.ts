import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, type Address, type Hex } from "viem";

export type Holder = {id: bigint; owner: Address};
export function shareTree(batchId: bigint, ticker: Hex, holders: Holder[]) {
  if (!holders.length || holders.length > 250) throw Error("Invalid clan size");
  const sorted = [...holders].sort((a,b)=>a.id<b.id?-1:1);
  if(new Set(sorted.map(h=>h.id.toString())).size!==sorted.length) throw Error("Duplicate DEEDZ");
  const values=sorted.map((h,index)=>[batchId.toString(),h.id.toString(),getAddress(h.owner),index.toString()]);
  const tree=StandardMerkleTree.of(values,["uint256","uint256","address","uint256"]);
  return {id:batchId.toString(),ticker,root:tree.root,mode:"shares",holderCount:holders.length,
    claims:[...tree.entries()].map(([i,v])=>({batchId:v[0],tokenId:v[1],account:v[2],shareIndex:v[3],proof:tree.getProof(i)}))};
}

export async function eligibleGroups(deed:any, blockNumber:bigint) {
  const opts={blockNumber}; const count=await deed.read.totalMinted(opts);
  if(count>2500n) throw Error("Unexpected DEEDZ supply");
  const groups=new Map<string,{ticker:Hex;holders:Holder[]}>();
  for(let start=1n;start<=count;start+=25n) {
    const ids=Array.from({length:Number(count-start+1n>25n?25n:count-start+1n)},(_,i)=>start+BigInt(i));
    await Promise.all(ids.map(async id=>{
      const state=Number(await deed.read.stateOf([id],opts));
      if(state!==1 && state!==2)return; // Grace remains earning until Dark.
      const [data,owner]=await Promise.all([deed.read.deedData([id],opts),deed.read.ownerOf([id],opts)]);
      const ticker=data.ticker??data[0];const group:{ticker:Hex;holders:Holder[]}=groups.get(ticker)??{ticker,holders:[]};
      group.holders.push({id,owner});groups.set(ticker,group);
    }));
  }
  return [...groups.values()].sort((a,b)=>a.ticker.localeCompare(b.ticker));
}

export function minimumOutput(quote:bigint, slippageBps:number) {
  if(!Number.isInteger(slippageBps)||slippageBps<1||slippageBps>500)throw Error("Slippage must be 1–500 bps");
  const min=quote*BigInt(10000-slippageBps)/10000n;
  if(min===0n)throw Error("Purchase too small");return min;
}

export async function planCycle(client:any,deed:any,processor:any,rewards:any,adapter:any,slippageBps=50) {
  const block=await client.getBlock();const opts={blockNumber:block.number};
  const [last,interval,fees,batch]=await Promise.all([processor.read.lastCycleAt(opts),processor.read.INTERVAL(opts),processor.read.queuedTradingFees(opts),rewards.read.batchCount(opts)]);
  if(block.timestamp<last+interval)return {skip:"Cycle not ready"};
  if(fees===0n)return {skip:"No trading fees"};
  const groups=await eligibleGroups(deed,block.number);const active=groups.reduce((n,g)=>n+g.holders.length,0);
  if(!active)return {skip:"No eligible holders; fees stay queued"};
  const total=fees*70n/100n;let used=0n;const allocations:any[]=[],manifests:any[]=[];
  for(let i=0;i<groups.length;i++) {
    const group=groups[i],ethAmount=i===groups.length-1?total-used:total*BigInt(group.holders.length)/BigInt(active);used+=ethAmount;
    if(ethAmount===0n)return {skip:"Fees too small for every eligible clan"};
    const stock=await rewards.read.stockToken([group.ticker]);const route=await adapter.read.routes([group.ticker]);
    if(getAddress(route[0])!==getAddress(stock))throw Error("Stock route/rewards identity mismatch");
    const {result:quote}=await client.simulateContract({address:adapter.address,abi:adapter.abi,functionName:"buyStock",args:[group.ticker,processor.address,1n],account:processor.address,value:ethAmount});
    const minimum=minimumOutput(quote,slippageBps);
    if(minimum<BigInt(group.holders.length))return {skip:"Stock output below one unit per holder"};
    const manifest=shareTree(batch+BigInt(i),group.ticker,group.holders);manifests.push(manifest);
    allocations.push({ticker:group.ticker,ethAmount,minimumStockOut:minimum,merkleRoot:manifest.root,holderCount:BigInt(group.holders.length)});
  }
  const deadline=(await client.getBlock()).timestamp+120n;
  return {kind:"cycle",snapshotBlock:block.number.toString(),manifests,args:[allocations,fees,batch,deadline]};
}

export async function planSunday(client:any,deed:any,treasury:any,settlement:any,rewards:any,adapter:any,week:bigint,slippageBps=50) {
  if(await settlement.read.settled([week]))return {skip:"Week already settled"};
  if(!await treasury.read.weekFinalized([week]))return {skip:"Week needs checkpoint/finalization"};
  const total=await treasury.read.distributableRentEth([week]);if(total===0n)return {skip:"No earned rent"};
  const block=await client.getBlock();const [winner]=await settlement.read.winningClan([week]);
  const group=(await eligibleGroups(deed,block.number)).find(g=>g.ticker===winner);
  if(!group)return {skip:"Winning clan has no eligible holders; rent stays queued"};
  const batch=await rewards.read.batchCount();const manifest=shareTree(batch,winner,group.holders);
  // eth_call cannot fund a settlement that has not released its rent yet. Simulate
  // the complete atomic settlement to obtain both outputs, with nonzero probe bounds.
  const probeDeadline=(await client.getBlock()).timestamp+120n;
  const {result}=await client.simulateContract({address:settlement.address,abi:settlement.abi,functionName:"settleStocks",
    args:[week,1n,1n,manifest.root,BigInt(group.holders.length),batch,probeDeadline],account:await settlement.read.keeper()});
  const deadline=(await client.getBlock()).timestamp+120n;
  return {kind:"sunday",snapshotBlock:block.number.toString(),manifests:[{...manifest,week:week.toString()}],
    args:[week,minimumOutput(result[0],slippageBps),minimumOutput(result[1],slippageBps),manifest.root,BigInt(group.holders.length),batch,deadline]};
}

export async function completedManifests(rewards:any,plan:any,hash:Hex) {
  const batches=[];
  for(const m of plan.manifests) {
    const b=await rewards.read.batches([BigInt(m.id)]);
    if(b[2].toLowerCase()!==m.root.toLowerCase())throw Error("On-chain batch root mismatch; refusing publication");
    const size=await rewards.read.batchSize([BigInt(m.id)]);
    if(size!==BigInt(m.holderCount))throw Error("On-chain share count mismatch");
    batches.push({...m,funded:b[3].toString(),transaction:hash,snapshotBlock:plan.snapshotBlock,
      claims:m.claims.map((c:any)=>{const i=BigInt(c.shareIndex);return {...c,amount:(b[3]*(i+1n)/size-b[3]*i/size).toString()};})});
  }
  return batches;
}

// Publish credits in small transactions. Replaying a partially registered batch is safe.
export async function registerRewardClaims(rewards:any, manifests:any[], send:(contract:any,name:string,args:any[])=>Promise<unknown>) {
  for (const manifest of manifests) {
    const id = BigInt(manifest.id), batch = await rewards.read.batches([id]);
    if (batch[2].toLowerCase() !== manifest.root.toLowerCase()) throw Error("Registration root mismatch");
    if (batch[4] === batch[3]) continue;
    for (let start=0; start<manifest.claims.length; start+=25) {
      const entries = manifest.claims.slice(start,start+25);
      const consumed = await Promise.all(entries.map((c:any)=>rewards.read.tokenClaimed([id,BigInt(c.tokenId)])));
      const pending = entries.filter((_:any,i:number)=>!consumed[i]).map((c:any)=>({
        tokenId:BigInt(c.tokenId),account:getAddress(c.account),
        amount:BigInt(manifest.mode === "shares" ? c.shareIndex : c.amount),proof:c.proof,
      }));
      if (pending.length) await send(rewards,"registerClaims",[id,pending]);
    }
  }
}

export async function planLiquidity(client:any,liquidity:any,router:any,rent:any,keeper:Address,slippageBps=50) {
  if(getAddress(await liquidity.read.executor())!==getAddress(keeper))throw Error("Liquidity executor differs from keeper");
  const eth=await client.getBalance({address:liquidity.address});
  if(eth<1000n)return {skip:"No liquidity ETH"};
  const half=eth/2n,deadline=(await client.getBlock()).timestamp+120n;
  const {result:quote}=await client.simulateContract({address:router.address,abi:router.abi,functionName:"swapExactInputEthForRent",args:[1n,deadline],account:liquidity.address,value:half});
  const min=minimumOutput(quote,slippageBps),held=await rent.read.balanceOf([liquidity.address]);
  const args=[half,min,eth,held+min,1n,deadline];
  const {result:lp}=await client.simulateContract({address:liquidity.address,abi:liquidity.abi,functionName:"reinvest",args,account:keeper});
  args[4]=minimumOutput(lp,slippageBps);return {args};
}
