# Robinhood stock execution — 5 October 2026

## Replacement public testnet suite — 6 October 2026

The current testnet deployment is recorded in `deployments/robinhood-testnet-stock.json`. Its `status` must be `deployed` before use. It replaces the old TestExchange suite for the website and keeper. The statements below about no live deployment are historical mainnet/fork notes; mainnet deployment remains pending.

The testnet uses the new PonsStockAdapter, StockRewards single-argument claim interface, COIN clan, real Uniswap V3 pool bytecode, ten test stock tokens, and a synthetic $2,500 ETH/USD feed. It is a separate test venue, not mainnet Pons. Old NFTs, RENT balances and reward credits remain at their old addresses. The new deployment manifest records every deployment/configuration transaction; no private keys are included.

The existing `testnet-protocol-keeper.yml` workflow now reads the new manifest and runs `operate:stock-keeper` for stock cycles, all completed rent weeks, credit registration and liquidity reinvestment. Cloudflare continues to dispatch the same filename. The duplicate GitHub-native cron has been removed; keep one Cloudflare cron (`*/15 * * * *`). This is 96 scheduled checks per day; actual stock cycles still require the contract's three-hour interval, queued trading fees and eligible holders. Runner delays can add latency.

Public recovery state is isolated under `keeper-data/stock-testnet`. GitHub commits/pushes reward plans before sending a stock transaction, then publishes actual funded share amounts and registers wallet credits. Ten journal tests cover eligibility, receipts, restart recovery and share rounding. An unresolved transaction blocks duplicate spending until reconciled. Keys are exposed only to transaction steps. The same deployer remains keeper across all four keeper/executor roles.

`npm run test:stock-testnet-fork` forks the actual new deployment on chain 46630 into local chain 31337 and advances local time to exercise all ten stock buys/sales, NFT lifecycle and buyouts, reward ownership/claims, fee splits, Sunday settlement, RENT burns and liquidity. Its output is `deployments/testnet-stock-fork-verification.json`; read its status before claiming success. Public-chain smoke state is `keeper-data/stock-testnet/smoke.json`; `waiting-for-cycle` means the three-hour clock has not yet completed, not a completed reward claim.

The website's committed `src/config/robinhood-testnet.json` takes precedence over stale testnet address environment variables. `/api/deployment` exposes its effective public addresses. Test `/buy-rent`, `/mint`, `/light`, `/my-deeds`, `/market`, `/swap` and `/rewards`. Stock sells are currently a contract/script flow, not a website button. The new testnet does not establish mainnet launch readiness; the oracle and economic limitations below remain.


The stock integration lives in `Deeds/apps/packages/contracts`, which is the newer contract repository. `Deeds/packages/contracts` is an older copy and was not changed.

## Implemented flow

1. RENT/ETH trading uses the existing Uniswap V4 `TradingRouter` and its 5% ETH fee.
2. `FeeProcessor.processStockCycle` spends the prepared 70% reward allocation through `PonsStockAdapter`. Newly arriving fees remain queued. The 20% liquidity and 10% team accounting stays separate.
3. The adapter wraps ETH and executes against factory-validated Pons V3 pools: WETH/stock where configured, otherwise WETH/USDG/stock. This keeps the RENT/ETH pool on V4. Canonical token identities come from Robinhood's asset registry; Ink's Quotrons addresses are not reused.
4. Reward batches commit holder membership and equal-share indices. Claims divide the actual received stock balance, including integer rounding. Predicted prices never determine the funded liability. Each batch contains at most 250 holders, and a cycle contains at most ten clans.
5. The keeper registers proven wallet credits on-chain in groups of 25 (the contract caps each registration at 50). Holders call `claimStockRewards(tokenId)` to collect all their recorded rewards for that NFT in one transfer. Rewards stay with their earning wallet when an NFT is sold. The existing proof-based `claim` remains a recovery path; both paths consume the same batch entitlement. `PonsStockAdapter.sellStock` can sell the caller's own claimed tokens back to native ETH after exact-amount approval. The adapter does not sell stock held by the rewards contract. There is no stock-sale button in the web UI in this change.
6. Sunday uses `settleStocks`: 50% buys and burns RENT, 25% goes to protocol liquidity, 20% buys the winning clan's stock, and 5% goes to the team. The keeper reinvests liquidity after saving confirmed reward proofs.

Stock clans are NVDA, TSLA, AAPL, MSFT, AMZN, META, GOOGL, NFLX, AMD and COIN. New final-contract source and the web list use COIN; previously deployed PLTR contracts do not change automatically.

## Keeper

The deployer is the default keeper. The runner reads `DEEDZ_KEEPER_PRIVATE_KEY` if supplied, otherwise `PRIVATE_KEY`. The key is used only when `DEEDZ_KEEPER_EXECUTE=1`; the default is simulation. Keys remain server-side.

Future keeper rotation must update `FeeProcessor.setKeeper`, `SundaySettlement.setKeeper`, `RentTreasury.setKeeper`, and `ProtocolLiquidityManager.setExecutor` using their owner. Set the new key only after all four roles match. The runner verifies the roles before sending.

Set `DEEDZ_STOCK_MANIFEST` to an actual deployed-suite JSON containing `chainId`, `rpcUrl`, and `contracts` addresses for `deed`, `processor`, `rewards`, `adapter`, `treasury`, `settlement`, `liquidity`, `router` and `rent`. The runner rejects a local-fork manifest for a live network and checks chain identity, code and adapter wiring. The replacement public testnet manifest is `deployments/robinhood-testnet-stock.json`; no mainnet deployment manifest has been generated.

From the contract directory:

```powershell
npm run test:stock
$env:STOCK_FORK_BLOCK = '' # Use fresh public-RPC state; pin only with archive access.
npm run test:stock-fork
# Simulation only, once a real deployment manifest exists:
$env:DEEDZ_STOCK_MANIFEST = 'deployments/your-stock-suite.json'
npm run operate:stock-keeper
```

For Sunday, set `DEEDZ_KEEPER_ACTION=sunday`; `DEEDZ_SETTLE_WEEK` selects a backlog week. Otherwise the runner walks all completed unsettled weeks. Execution first checkpoints rent in bounded batches and finalizes the week. An empty cycle, unavailable route, or missing eligible winner leaves funds queued.

The default slippage allowance is 50 basis points, configurable with `DEEDZ_SLIPPAGE_BPS` between 1 and 500. Every complete keeper transaction is simulated before submission and expires after 120 seconds. As in Cycle's selected model, execution prices and eligibility are trusted keeper inputs, not independent on-chain price-oracle or membership proofs. Pool availability and liquidity must be rechecked at execution time.

`keeper-data/stock/pending.json` is saved before submitting. Confirmed outputs are checked against batch roots and published atomically into `rewards.json`. A restart can recover confirmed batches even if receipt publication was interrupted. An unresolved prepared transaction or process lock stops another submission until the prior process/nonce is reconciled. Keep this directory on persistent storage. The optional `DEEDZ_KEEPER_DATA` changes its location. Proofs are saved before a liquidity operation, so a liquidity failure does not hide successful rewards.

The new reward page reads wallet credits, NFT IDs and cumulative claims directly from the contract in bounded pages. It does not require a proof server. The keeper saves proofs before registration, resumes partially registered batches on restart, and retries older unpublished credits before new distributions. Registration costs keeper gas and must complete before a credit becomes visible. `Batch.claimed` includes credited/reserved units as well as direct proof payouts; `claimableStock` and `claimedStock` distinguish credit from withdrawal. For older immutable deployments, the web server reads `DEEDZ_REWARDS_FILE` for a local/persistent file or `DEEDZ_REWARDS_URL` for a published JSON. It validates both the configured chain ID and rewards-contract address. The reward page reads share amounts on-chain and shows data failures instead of reporting a false empty balance. The old GitHub proof URL remains the fallback for legacy deployments. Publishing new proof records to a hosted server and starting a recurring keeper are still deployment operations.

## Verification boundaries

See `deployments/stock-fork/result.json` for the recorded status, source block, purchased amounts, stock-sale transactions and Sunday outputs. The fork asserts source chain 4663 and local chain 31337. It creates new DEEDZ contracts and RENT liquidity locally and copies canonical stock tokens, V3 pools and the Robinhood V4 PoolManager without changing their code or storage. The ETH/USD feed is an explicitly named local `TestPriceFeed`; this work does not validate a production rent valuation oracle. Deterministic local block timestamps keep RPC hydration delays from expiring test transactions.

The initial fork work did not deploy the website/contracts; the replacement testnet deployment is described at the top of this document. Existing immutable contracts require replacement to use the new entrypoints and reward accounting. The old fixed-rate `TestExchange` scripts remain historical test tooling; use `operate:stock-keeper` for this integration.

The owner approved retaining the $5 minimum valuation and sending unused seller rent to the team on 5 October 2026. The single-argument claim requirement is now implemented. The extra 5% NFT purchase fee and deposit-based jackpot scoring remain unresolved against the written requirements and were not changed in this update. This verification is specifically stock execution, fee/reward accounting and its connected fork flow, not a full protocol audit or live keeper-uptime test.

Primary address sources: [Robinhood token contracts](https://docs.robinhood.com/chain/contracts/), [Robinhood asset registry](https://api.robinhood.com/rhj/assets), and [Pons venue documentation](https://docs.ponsfamily.com/). The address discovery is retained in `config/robinhood-stock-discovery.json`; configured routes are in `config/robinhood-stock-routes.json`.

Verification completed for the single-argument claim update: 18 contract tests passed; web typecheck, targeted lint, keeper helper typecheck, runner syntax check and production build passed. The fresh Robinhood fork at source block 80906708 passed all 9 check groups, including all ten stock purchases and sales, eleven single-argument claims, replay/wrong-wallet protection, Sunday stock claims and liquidity reinvestment. Report source hashes match the final source. The earlier pinned block could not serve an uncached historical storage slot on the public RPC; the successful rerun used a fresh block. No live deployment or transaction occurred.


Production ETH/USD follow-up: the real Chainlink adapter and final NFT/treasury flow are now fork-tested separately. See ORACLE_INTEGRATION.md and deployments/oracle-fork/result.json. The stock-swap report above remains a separate verification run. Live deployment and sequencer-outage protection remain pending.


## GitHub Actions testnet keeper follow-up - 5 October 2026

The user added KEEPER_PRIVATE_KEY and authorized testing GitHub Actions on Robinhood testnet. Read-only inspection of run 37280677061 confirmed secret validation, compilation, and keeper wallet validation passed. The cycle skipped because no fees were queued; Sunday failed with "Week 1: winning clan has no Lit holders". Run: https://github.com/bakhi107/deedz-packages/actions/runs/37280677061.

Testnet chain 46630 currently has 10 NFTs (all activated NFTs Dark), 13 historical reward batches, zero queued fees, and keeper 0xB174D2D54F30dEdDEcf1ba2a24862E8c2d917662 with approximately 0.03176 test ETH. No transaction was submitted in this follow-up.

Local changes in apps/packages: the legacy keeper now includes grace eligibility and skips empty winning clans without releasing their funds. Public reward plans are committed/pushed before broadcast on GitHub, confirmed roots and funded amounts are checked, and interrupted proof publication can recover on the next run. An unresolved unconfirmed plan deliberately blocks further sends until its nonce is reconciled. Six recovery/eligibility tests pass; keeper scripts pass syntax checks; workflow YAML parses. Only operation steps receive the private key, not dependency installation or compilation.

The workflow has a manual smoke_test input. It can mint/light one keeper-owned NVDA test NFT, seed a 0.00002-test-ETH trade, execute the existing testnet keeper, claim its legacy proof-based reward, and verify stock balance increased. Its checkpoint avoids reseeding a completed smoke test. Run it twice to verify repeat execution. This smoke script has been prepared but has NOT been run. These existing immutable contracts use TestExchange and the legacy claim interface; this does not validate a live Pons deployment or the new claimStockRewards entrypoint.

BLOCKER: local gh login for placeparks is invalid (HTTP 401), and the connected GitHub app has pull=true, push=false on bakhi107/deedz-packages. The user was asked to run gh auth login -h github.com with repository write access. No commit, push, workflow dispatch, or deployment occurred. After authentication, publish only the reviewed workflow and legacy keeper changes (preserve the other uncommitted stock/oracle work), dispatch testnet-protocol-keeper.yml with smoke_test=true, inspect receipts/proofs, then repeat the run. Do not report live test success until verified.

## GitHub Actions testnet verification completed - 5 October 2026

The GitHub authentication blocker above is resolved. The user authenticated as bakhi107 and explicitly authorized pushing. Keeper/workflow fixes were pushed to main in eb4ba57 and dddf215; unrelated uncommitted stock/oracle changes were preserved. Two subsequent full workflow runs succeeded:
- https://github.com/bakhi107/deedz-packages/actions/runs/37347804640
- https://github.com/bakhi107/deedz-packages/actions/runs/37348015946

On Robinhood testnet 46630, GitHub Actions minted and lit NVDA DEEDZ #11 for keeper 0xB174D2D54F30dEdDEcf1ba2a24862E8c2d917662, traded 0.00002 test ETH, queued 0.000001 test ETH of fees, funded reward batch 13, and claimed 0.0007 test NVDA. Read-only verification checked successful transaction receipts, the funded Merkle root/amount, tokenClaimed, wallet stock balance, and the exact 70/20/10 fee split. Stock purchase transaction: 0x82cb28f1d778baf2145e94d068667ba144f0b70ef52591200efe998938eb46ba. Claim: 0xcecb16362f954aeef97496aa7870a446d500837c969d8dfa3b844319582c17ec. Public evidence: apps/packages/contracts/keeper-data/smoke.json, rewards.json, and smoke-verification.json.

The initial run's cycle succeeded but a Sunday checkpoint receipt briefly disappeared from the public RPC. That transaction was independently confirmed successful. The keeper now polls the same hash with a bounded timeout instead of resending transactions. All eight recovery/eligibility/receipt tests passed locally and in Actions. A repeat workflow reused the saved smoke test, skipped the not-yet-due cycle, made no duplicate trade or claim, and passed. Old Sunday weeks 1 and 2 have no eligible winning holders; their funds remain in the treasury and the keeper continues without failing.

The existing five-minute GitHub schedule remains active; cycle execution still observes the contract's three-hour interval. This verifies actual GitHub signing, testnet transactions, durable reward publication, restart continuation and legacy proof-based claims. These are the existing TestExchange/test-price-feed testnet contracts, not a live Pons/mainnet deployment or the new single-argument claim interface. No mainnet transaction or deployment occurred. Live RPC timing caused one transient failure before the receipt fix; these successful runs are not an uptime guarantee.

## GitHub schedule delivery correction - 5 October 2026, 18:03 UTC

The user correctly observed no new five-minute automatic runs. GitHub API inspection confirmed the workflow is active, repository Actions are enabled, and the schedule is on main; however, the last actual schedule event was 2026-10-05 17:00:42 UTC (10:00 AM Pacific). The successful 17:21 and 17:23 runs were workflow_dispatch (manual) events. Thus transaction/keeper execution is verified, but reliable recurring delivery is NOT verified. A skipped three-hour cycle would still appear as a workflow run; the absence of new runs is a trigger-delivery issue, not the contract's interval check.

Published fec80e3 changes the five-minute cron to 2-59/5 * * * * to avoid minute 0 and common five-minute boundaries, following GitHub's documented delay mitigation. Workflow YAML validation passed and the workflow remains active. No subsequent automatic run was visible in the 18:03 UTC check; this change is a mitigation, not a confirmed fix. GitHub reports Actions operational, so the exact cause of this repository's missing triggers is not established. GitHub documents that scheduled jobs may be delayed or dropped under load: https://docs.github.com/en/actions/how-tos/troubleshoot-workflows. Do not promise exact three-hour execution based on the manual tests. No manual run was dispatched for this schedule diagnosis, and no new transaction was sent.

### Replacement testnet verification results

The new deployed-suite fork passed all six check groups at source testnet block 129869709: all ten stock purchases and sales, fee splits, NFT lifecycle, seller proceeds, previous-wallet rewards, single-argument claims/replay protection, Sunday settlement, liquidity and relighting. See deployments/testnet-stock-fork-verification.json. All 18 protocol/stock tests, 6 oracle tests and 10 durable keeper tests passed. The frontend typecheck, targeted lint, production build and local effective-address endpoint check passed.

Public testnet sample NFT #1 was minted and lit, then a 0.00002-test-ETH RENT trade confirmed. Sample receipts are in keeper-data/stock-testnet/smoke.json. Its first public stock cycle is due after 2026-10-06 15:13:37 UTC; the sample stock claim remains pending until a keeper cycle funds and registers it. This is distinct from the completed time-advanced fork verification.
