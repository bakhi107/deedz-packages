// @ts-nocheck
import { network } from "hardhat";
import { getAddress, isAddress, parseEther } from "viem";
const {viem}=await network.create({network:"robinhoodTestnet",chainType:"generic"}); const client=await viem.getPublicClient(); const [wallet]=await viem.getWalletClients();
const rent=await viem.getContractAt("RentToken",env("FINAL_RENT")); const processor=await viem.getContractAt("FeeProcessor",env("FINAL_PROCESSOR")); const settlement=await viem.getContractAt("SundaySettlement",env("FINAL_SETTLEMENT"));
const manager=await viem.deployContract("ProtocolLiquidityManager",[wallet.account.address,wallet.account.address]);
async function mined(p:Promise<`0x${string}`>){const hash=await p;const r=await client.waitForTransactionReceipt({hash});if(r.status!=="success")throw new Error(`Failed ${hash}`);}
await mined(manager.write.configureRouter([env("FINAL_TRADING_ROUTER")])); await mined(rent.write.transfer([manager.address,100_000n*10n**18n])); await mined(processor.write.setLiquidity([manager.address])); await mined(settlement.write.setLiquidity([manager.address]));
if((await processor.read.liquidity()).toLowerCase()!==manager.address.toLowerCase()||(await settlement.read.liquidity()).toLowerCase()!==manager.address.toLowerCase())throw new Error("Liquidity wiring failed");
console.log(`FINAL_LIQUIDITY_MANAGER=${manager.address}`);
function env(name:string){const value=process.env[name];if(!value||!isAddress(value))throw new Error(`${name} missing`);return getAddress(value);}
