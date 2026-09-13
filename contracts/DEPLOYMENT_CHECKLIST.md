# DEEDZ Deployment Checklist

This is the release gate for testnet and mainnet. A deployment is **not complete** until every applicable box is checked and its address or transaction is recorded in the environment/manifest.

## 1. Network and external dependencies

- [ ] Confirm chain ID and RPC (`46630` testnet; `4663` mainnet).
- [ ] Confirm deployer, team multisig, and dedicated keeper addresses.
- [ ] Verify canonical Uniswap v4 PoolManager, StateView, routers, Permit2, and CREATE2 deployer bytecode.
- [ ] Verify every stock-token address, symbol, decimals, and available liquidity.
- [ ] Testnet only: use canonical Robinhood TSLA, AMZN, NFLX, AMD, PLTR; deploy mocks only for NVDA, AAPL, MSFT, META, GOOGL.

## 2. Deployments

- [ ] RENT token (fixed 1 billion supply).
- [ ] ETH/USD oracle or approved test feed.
- [ ] RentTreasury.
- [ ] StockRewards.
- [ ] Stock exchange adapter(s) for all ten clans.
- [ ] FeeProcessor.
- [ ] SundaySettlement.
- [ ] Deed and DeedArt.
- [ ] Uniswap v4 RENT/ETH hook, router, and initialized pool.
- [ ] Seed RENT/ETH liquidity.
- [ ] Testnet only: 50,000 RENT faucet with two-claim lifetime limit.

## 3. Mandatory wiring

- [ ] Treasury → Deed and SundaySettlement.
- [ ] Deed → RENT, Treasury, FeeProcessor.
- [ ] Rewards → FeeProcessor and SundaySettlement authorization.
- [ ] Rewards/Exchange → all ten stock tokens.
- [ ] Uniswap hook → correct pool and router.
- [ ] Uniswap fee route → current FeeProcessor (5% fee; 70/20/10).
- [ ] FeeProcessor and SundaySettlement → actual liquidity destination.
- [ ] Keeper address matches the GitHub secret wallet and has gas.
- [ ] Remove all temporary deployer permissions.

## 4. Required behavior tests

- [ ] Free mint and 250-per-clan cap.
- [ ] Burn exactly 25,000 RENT on light/relight.
- [ ] Seven-day runway, automatic grace, and automatic Dark state.
- [ ] Immediate non-refundable Clan Wars scoring and time-earned Sunday accounting.
- [ ] Forced purchase: seller payment, 5% team fee, fresh buyer runway, unused seller runway to team.
- [ ] Real Uniswap smoke swaps in both directions.
- [ ] Confirm the swap charges exactly 5% and increases `queuedTradingFees` on the current FeeProcessor.
- [ ] Three-hour keeper cycle produces the exact 70/20/10 split and valid claim proofs.
- [ ] Reward claim succeeds and remains permanently recorded.
- [ ] Sunday checkpoint/settlement produces the exact 50/25/20/5 split.
- [ ] Going Dark SVG metadata and all ten ticker designs render correctly.

## 5. Deployment verification

- [ ] Bytecode exists at every address.
- [ ] All reciprocal links and roles match.
- [ ] Token supply/reserves and clan mapping match specification.
- [ ] Contract source is verified on the explorer where supported.
- [ ] Deployment block and all addresses are saved in the environment/manifest.
- [ ] No private key appears in Git history or tracked environment files.

## 6. Automation and applications

- [ ] GitHub workflow YAML validates before push.
- [ ] Manual keeper run succeeds; scheduled run succeeds afterward.
- [ ] Empty/not-ready cycles exit without sending a transaction.
- [ ] Reward proof file is published and the web API reads it.
- [ ] Mint environment points to the current Deed.
- [ ] Web environment points to current RENT, Deed, Treasury, pool/router, FeeProcessor, Rewards, faucet, and deployment block.
- [ ] Mint and web production builds pass.
- [ ] Vercel production variables are updated and both hosted applications are smoke-tested.
- [ ] Contracts, mint, and web repositories are pushed at the tested commits.

## Current release blocker

The final RENT deployment is not yet connected to a new Uniswap v4 hook/pool. The current test trading pool is not a substitute for the mandatory real-hook smoke test. Do not call this release complete until that integration and test are finished.
