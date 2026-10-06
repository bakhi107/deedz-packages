// @ts-nocheck
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { network, artifacts } from "hardhat";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient,http,parseEther,stringToHex,zeroAddress,zeroHash,encodeDeployData,getContractAddress,numberToHex,concatHex,maxUint256,getAddress } from "viem";
import { planCycle,planSunday,completedManifests,eligibleGroups,planLiquidity,registerRewardClaims } from "./keeper.js";

const report:any={status:"running",sourceChainId:4663,localChainId:31337,checks:[],purchases:[],sales:[],limitations:["New DEEDZ contracts and RENT/ETH liquidity are created only on the local fork. Stock tokens and V3 liquidity are copied unchanged from Robinhood.","Keeper supplies execution bounds; quotes are not independent fair-value oracles.","No live transaction, hosted deployment or continuously running keeper is exercised."]};
const save=()=>{mkdirSync("deployments/stock-fork",{recursive:true});writeFileSync("deployments/stock-fork/result.json",JSON.stringify(report,(_,v)=>typeof v==="bigint"?v.toString():v,2)+"\n");};
const pass=(s:string)=>{report.checks.push(s);console.log("PASS "+s);save();};
report.sourceHashes=Object.fromEntries(["contracts/final/PonsStockAdapter.sol","contracts/final/FeeProcessor.sol","contracts/final/StockRewards.sol","contracts/final/SundaySettlement.sol","contracts/final/Deed.sol","contracts/final/RentTreasury.sol","scripts/stock/keeper.ts"].map(p=>[p,createHash("sha256").update(readFileSync(p)).digest("hex")]));
let connection;
try {
 const routes=JSON.parse(readFileSync("config/robinhood-stock-routes.json","utf8"));
 const remote=createPublicClient({transport:http(process.env.STOCK_FORK_RPC??routes.rpcUrl)});
 assert.equal(await remote.getChainId(),4663);
 connection=await network.create({network:"stockFork"});
 // Deterministic fork mining: remote state hydration must not age a local quote.
 // This only sets timestamps on the isolated provider; external pool state is unchanged.
 const request=connection.provider.request.bind(connection.provider);
 connection.provider.request=async (payload:any)=>{
  if(payload.method==="eth_sendTransaction" || payload.method==="eth_sendRawTransaction"){
   const latest=await request({method:"eth_getBlockByNumber",params:["latest",false]});
   await request({method:"evm_setNextBlockTimestamp",params:[Number(BigInt(latest.timestamp))+1]});
  }
  return request(payload);
 };
 const {viem,networkHelpers:nh}=connection;
 const client=await viem.getPublicClient();assert.equal(await client.getChainId(),31337);
 const metadata=await connection.provider.request({method:"hardhat_metadata"});
 assert.equal(Number(metadata.forkedNetwork.chainId),4663);report.sourceBlock=metadata.forkedNetwork.forkBlockNumber;
 const [owner,holder,other,team]=await viem.getWalletClients();
 const address=owner.account.address;report.keeper=address;report.deployer=address;
 const mined=async(p:any)=>{const hash=await p;const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,"success");return hash;};
 const deploy=async(n:string,args:any[])=>viem.deployContract(n,args);
 const rent=await deploy("RentToken",[address]);
 const adapter=await deploy("PonsStockAdapter",[address,routes.factory,routes.weth,routes.usdg,rent.address]);
 const feed=await deploy("TestPriceFeed",[address,2_500_000_000n]);
 const treasury=await deploy("RentTreasury",[address,address,team.account.address,feed.address]);
 const rewards=await deploy("StockRewards",[address,address]);
 const lp=await deploy("ProtocolLiquidityManager",[address,address]);
 const fees=await deploy("FeeProcessor",[address,address,rewards.address,adapter.address,lp.address,team.account.address]);
 const sunday=await deploy("SundaySettlement",[address,address,treasury.address,rewards.address,rent.address,adapter.address,lp.address,team.account.address]);
 const deed=await deploy("contracts/final/Deed.sol:Deed",[address,rent.address,treasury.address,fees.address]);
 await mined(treasury.write.configureDeed([deed.address]));await mined(treasury.write.configureSettlement([sunday.address]));
 await mined(rewards.write.setProcessor([fees.address,true]));await mined(rewards.write.setProcessor([sunday.address,true]));await mined(rewards.write.setProcessor([address,false]));
 await mined(adapter.write.setBuyer([fees.address,true]));await mined(adapter.write.setBuyer([sunday.address,true]));await mined(adapter.write.setFundingPool([routes.fundingPool]));
 for(const s of routes.stocks){const ticker=stringToHex(s.ticker,{size:32});await mined(adapter.write.configureStock([ticker,s.token,s.pool,s.viaUSDG]));await mined(rewards.write.configureStock([ticker,s.token]));}
 // Use the actual copied Robinhood V4 PoolManager and a CREATE2-valid new RENT hook.
 const managerAddress=getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),factory=getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C");
 const art=await artifacts.readArtifact("TradingHook");const init=encodeDeployData({abi:art.abi,bytecode:art.bytecode,args:[managerAddress,address]});let salt,hook,nonce=0n;
 do{salt=numberToHex(nonce++,{size:32});hook=getContractAddress({opcode:"CREATE2",from:factory,salt,bytecode:init});}while((BigInt(hook)&16383n)!==128n);
 await mined(owner.sendTransaction({to:factory,data:concatHex([salt,init])}));
 const router=await deploy("TradingRouter",[managerAddress,rent.address,hook,fees.address]);
 const key={currency0:zeroAddress,currency1:rent.address,fee:0,tickSpacing:60,hooks:hook};
 const h=await viem.getContractAt("TradingHook",hook);await mined(h.write.configurePool([key,router.address]));
 const manager=await viem.getContractAt("V4PoolManager",managerAddress);await mined(manager.write.initialize([key,1000n*2n**96n]));
 const seed=await deploy("V4LiquidityRouter",[managerAddress]);await mined(rent.write.approve([seed.address,parseEther("200000000")]));
 await mined(seed.write.modifyLiquidity([key,{tickLower:-887220,tickUpper:887220,liquidityDelta:10n**23n,salt:zeroHash},"0x"],{value:parseEther("100")}));
 await mined(fees.write.setFeeSource([router.address,true]));await mined(lp.write.configureRouter([router.address]));await mined(adapter.write.setRentRouter([router.address]));
 report.contracts={rent:rent.address,adapter:adapter.address,deed:deed.address,treasury:treasury.address,rewards:rewards.address,processor:fees.address,settlement:sunday.address,liquidity:lp.address,router:router.address};
 pass("Isolated Robinhood fork; deployer is keeper; actual stock identities and registered pools validated");
 const token=(a:string)=>viem.getContractAt("TestStockToken",a); // ERC20 ABI only; no mock deployed or token storage modified.
 const daily=await treasury.read.dailyRentWei([8_000_000n]);
 await mined(rent.write.transfer([holder.account.address,parseEther("400000")]));await mined(rent.write.approve([deed.address,maxUint256],{account:holder.account}));
 for(const s of [...routes.stocks,routes.stocks[0]]){await mined(deed.write.mint([stringToHex(s.ticker,{size:32})],{account:holder.account}));const id=await deed.read.totalMinted();await mined(deed.write.light([id,8_000_000n],{account:holder.account,value:daily*7n}));}
 await mined(deed.write.mint([stringToHex("NVDA",{size:32})],{account:other.account}));
 await mined(rent.write.approve([router.address,maxUint256]));
 await mined(router.write.swapExactInputEthForRent([1n,(await client.getBlock()).timestamp+120n],{value:parseEther("0.02")}));
 assert.equal(await fees.read.queuedTradingFees(),parseEther("0.001"));
 await mined(router.write.swapExactInputRentForEth([parseEther("100"),1n,(await client.getBlock()).timestamp+120n]));
 assert.ok(await fees.read.queuedTradingFees()>parseEther("0.001"));
 pass("Real V4 RENT buy and sell charge 5% ETH fees into the current processor");
 await nh.time.increase(10801);const plan:any=await planCycle(client,deed,fees,rewards,adapter);assert.ok(!plan.skip,plan.skip);
 const f=await fees.read.queuedTradingFees(),lpBefore=await client.getBalance({address:lp.address});
 await assert.rejects(fees.write.processStockCycle(plan.args,{account:other.account}));
 const bad=structuredClone(plan.args);bad[0][0].minimumStockOut=maxUint256;
 await assert.rejects(fees.write.processStockCycle(bad));assert.equal(await fees.read.queuedTradingFees(),f);assert.equal(await rewards.read.batchCount(),0n);
 const tx=await mined(fees.write.processStockCycle(plan.args));
 assert.equal(await fees.read.teamBalance(),f-f*70n/100n-f*20n/100n);assert.equal(await client.getBalance({address:lp.address})-lpBefore,f*20n/100n);
 const manifests=await completedManifests(rewards,plan,tx);
 report.purchases=manifests.map(m=>({ticker:m.ticker,stockOut:m.funded,holders:m.holderCount,transaction:tx}));
 assert.equal(manifests.length,10);assert.equal(manifests.flatMap(m=>m.claims).length,11);
 pass("All ten stock purchases succeed; exact 70/20/10 split; failed swap rolls back the whole cycle");
 await registerRewardClaims(rewards,manifests,async(c,name,args)=>mined(c.write[name](args)));
 await registerRewardClaims(rewards,manifests,async()=>{throw Error("Already registered batch submitted again");});
 for(const m of manifests){const before=(await rewards.read.batches([BigInt(m.id)]))[3];let sum=0n;for(const c of m.claims){
   const args=[BigInt(c.batchId),BigInt(c.tokenId),BigInt(c.shareIndex),c.proof];
   await assert.rejects(rewards.write.claimStockRewards([BigInt(c.tokenId)],{account:other.account}));
   await assert.rejects(rewards.write.claim(args,{account:holder.account}));
   assert.equal(await rewards.read.claimableStock([holder.account.address,BigInt(c.tokenId)]),BigInt(c.amount));
   await mined(rewards.write.claimStockRewards([BigInt(c.tokenId)],{account:holder.account}));sum+=BigInt(c.amount);
   await assert.rejects(rewards.write.claimStockRewards([BigInt(c.tokenId)],{account:holder.account}));
 }assert.equal(sum,before);assert.equal((await rewards.read.batches([BigInt(m.id)]))[4],before);}
 pass("All eleven single-argument holder claims succeed; registration replay, wrong wallet and double-claim protections verified");
 for(const s of routes.stocks){const stock=await token(s.token);const amount=await stock.read.balanceOf([holder.account.address]);await mined(stock.write.approve([adapter.address,amount],{account:holder.account}));
  const args=[stringToHex(s.ticker,{size:32}),amount,1n,(await client.getBlock()).timestamp+120n];
  const q=await client.simulateContract({address:adapter.address,abi:adapter.abi,functionName:"sellStock",args,account:holder.account});args[2]=q.result*995n/1000n;
  const hash=await mined(adapter.write.sellStock(args,{account:holder.account}));assert.equal(await stock.read.balanceOf([holder.account.address]),0n);
  report.sales.push({ticker:s.ticker,stockIn:amount,quotedEth:q.result,transaction:hash});
 }
 assert.equal(await (await token(routes.weth)).read.balanceOf([adapter.address]),0n);assert.equal(await (await token(routes.usdg)).read.balanceOf([adapter.address]),0n);
 pass("Claimed stock from every clan sells back to ETH through actual Robinhood pools; no adapter WETH/USDG residue");
 async function reinvest(){
  const plan=await planLiquidity(client,lp,router,rent,owner.account.address);
  assert.ok(!plan.skip,plan.skip);await mined(lp.write.reinvest(plan.args));assert.ok(await lp.read.totalLiquidity()>0n);
 }
 await reinvest();pass("20% liquidity allocation reinvests into the actual RENT/ETH V4 pool with simulated output bounds");
 const week=await treasury.read.weekOf([(await client.getBlock()).timestamp]);await nh.time.increaseTo(await treasury.read.weekEnd([week])+1n);
 await mined(treasury.write.checkpointWeek([week,250n]));await mined(treasury.write.finalizeWeek([week]));
 const sp:any=await planSunday(client,deed,treasury,sunday,rewards,adapter,week);assert.ok(!sp.skip,sp.skip);
 const supply=await rent.read.totalSupply(),total=await treasury.read.distributableRentEth([week]),teamBefore=await client.getBalance({address:team.account.address}),beforeLP=await client.getBalance({address:lp.address});
 const sim=await client.simulateContract({address:sunday.address,abi:sunday.abi,functionName:"settleStocks",args:sp.args,account:owner.account});
 const stx=await mined(sunday.write.settleStocks(sp.args));assert.equal(supply-await rent.read.totalSupply(),sim.result[0]);
 assert.equal(await client.getBalance({address:lp.address})-beforeLP,total*25n/100n);
 assert.equal(await client.getBalance({address:team.account.address})-teamBefore,total-total*50n/100n-total*25n/100n-total*20n/100n);
 const jackpot=await completedManifests(rewards,sp,stx);
 await registerRewardClaims(rewards,jackpot,async(c,name,args)=>mined(c.write[name](args)));
 for(const c of jackpot[0].claims)await mined(rewards.write.claimStockRewards([BigInt(c.tokenId)],{account:holder.account}));
 await assert.rejects(sunday.write.settleStocks(sp.args));await reinvest();
 report.sunday={total,rentBurned:sim.result[0],stockOut:sim.result[1],transaction:stx};
 pass("Sunday executes 50/25/20/5: real RENT buy-and-burn, stock jackpot claims and liquidity reinvestment; repeat settlement rejected");
 const pos=await treasury.read.preview([1n]);await nh.time.increaseTo(pos[1]+60n);
 const grace=await eligibleGroups(deed,await client.getBlockNumber());assert.ok(grace.flatMap(g=>g.holders).some(h=>h.id===1n));
 await nh.time.increaseTo(pos[2]+1000n);assert.equal((await eligibleGroups(deed,await client.getBlockNumber())).length,0);
 assert.match((await planCycle(client,deed,fees,rewards,adapter)).skip,/No eligible/);
 pass("Grace holders remain eligible; Dormant and Dark holders excluded; no-holder fees remain queued");
 await mined(fees.write.setKeeper([other.account.address]));await mined(sunday.write.setKeeper([other.account.address]));await mined(treasury.write.setKeeper([other.account.address]));await mined(lp.write.setExecutor([other.account.address]));
 await assert.rejects(fees.write.processStockCycle(plan.args));assert.equal(getAddress(await fees.read.keeper()),getAddress(other.account.address));
 await assert.rejects(adapter.write.uniswapV3SwapCallback([1n,-1n,"0x"]));
 await assert.rejects(adapter.write.buyStock([stringToHex("NVDA",{size:32}),address,1n],{value:1n}));
 pass("Keeper rotation works; old keeper, unauthorized purchases and spoofed swap callbacks rejected");
 report.status="passed";save();
}catch(e){report.status="failed";report.error=e.shortMessage??e.message;save();throw e;}
finally{await connection?.close();}
