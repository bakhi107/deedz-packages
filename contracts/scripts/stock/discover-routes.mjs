import { createPublicClient, http, parseAbi, zeroAddress } from 'viem';
import { writeFileSync, mkdirSync } from 'node:fs';
const client = createPublicClient({transport:http('https://rpc.mainnet.chain.robinhood.com',{timeout:20000,retryCount:1})});
if(await client.getChainId()!==4663) throw Error('Wrong source chain');
const symbols=['NVDA','TSLA','AAPL','MSFT','AMZN','META','GOOGL','NFLX','AMD','COIN'];
const registry=await (await fetch('https://api.robinhood.com/rhj/assets')).json();
const factory='0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
const weth='0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const usdg='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const abi=parseAbi(['function getPool(address,address,uint24) view returns(address)','function liquidity() view returns(uint128)']);
const rows=[];
for(const symbol of [...symbols,'USDG']) {
 const asset=registry.assets.find(a=>a.tokenSymbol===symbol);
 const token=symbol==='USDG'?usdg:asset?.deployments.find(d=>d.chainId===4663)?.contractAddress;
 if(!token) throw Error('Missing canonical '+symbol);
 const pools=[];
 for(const quote of symbol==='USDG'?[weth]:[weth,usdg]) for(const fee of [100,500,3000,10000]) {
  const pool=await client.readContract({address:factory,abi,functionName:'getPool',args:[token,quote,fee]});
  if(pool!==zeroAddress) pools.push({quote,fee,pool,liquidity:String(await client.readContract({address:pool,abi,functionName:'liquidity'}))});
 }
 rows.push({symbol,token,pools}); console.log(JSON.stringify(rows.at(-1)));
}
mkdirSync('config',{recursive:true});
writeFileSync('config/robinhood-stock-discovery.json',JSON.stringify({chainId:4663,block:String(await client.getBlockNumber()),factory,weth,usdg,stocks:rows},null,2));
