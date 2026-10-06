# Chainlink ETH/USD integration — 5 October 2026

The final `RentTreasury` can use the existing read-only `EthUsdOracleV6` adapter. Its interface matches `IPriceFeed.latestPriceUsd6()`. The adapter preserves Chainlink's real update timestamp and converts the feed's precision to six USD decimals; it has no administrator-set price or fallback constant. Zero round IDs are now rejected along with invalid answers and timestamps.

## Deployment wiring

The public, verified Robinhood mainnet configuration is in `config/robinhood-eth-usd.json`:

- Source chain: 4663.
- ETH/USD proxy: `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`.
- Feed precision: 8 decimals; expected description: `ETH / USD`.
- Published heartbeat: 86,400 seconds; deviation threshold: 0.5%.

Deploy `EthUsdOracleV6` with the proxy as its constructor argument. Pass the **adapter address** as `feed_` when deploying the final `RentTreasury`; the proxy does not directly implement the treasury's six-decimal interface. Confirm `treasury.priceFeed() == adapter` and `adapter.feed() == proxy`. Both bindings are immutable. Existing deployed treasuries cannot have their oracle replaced in place.

The existing treasury enforces a maximum price age of 86,400 seconds. The adapter checks positive answers, nonzero rounds, completed rounds, nonzero timestamps, timestamps no later than the current block, supported precision and nonzero normalized values. The adapter deliberately returns the original timestamp, including for old prices; the consuming treasury enforces freshness.

Reading the existing feed requires no API key, subscription or per-read oracle payment. Deployments and transactions that read it consume ordinary gas.

## Reproducing verification

From `apps/packages/contracts`:

```powershell
npm run test:oracle
npm run test:stock
$env:STOCK_FORK_BLOCK = ''
npm run test:oracle-fork
```

The isolated fork uses source chain 4663 and local chain 31337. The test verifies the real proxy's identity and parameters, deploys the adapter and final contracts locally, and exercises valuation conversion, seven-day rent funding, lighting, burn rollback on underfunding, price changes, top-ups, NFT purchases, and seller proceeds. It advances only the local clock to prove the actual frozen Chainlink timestamp becomes stale. Neither the mainnet feed nor its storage/code is modified. No live transaction is signed or sent.

`deployments/oracle-fork/result.json` records the exact source block, feed round/answer/timestamp, example ETH amounts, checks and source hashes. Malformed answers and recovery are tested separately with an explicitly named local mock in `contracts/final/test/TestChainlinkRound.sol`; that mock is never used in the real-feed fork test.

## Remaining operational limits

- No live adapter or replacement treasury was deployed by these tests. Historical `deploy-final-testnet.ts` still uses test dependencies; it is not a mainnet deployment command.
- A delayed heartbeat beyond the existing 24-hour limit temporarily blocks price-dependent actions, including rent top-ups. Existing seller proceeds can still be withdrawn. Tests confirm rejected actions do not burn RENT or alter ownership/accounting.
- Robinhood recommends checking sequencer uptime, but Chainlink's published supported-network list does not include Robinhood and says it is no longer expanding uptime feeds. No Robinhood uptime-feed address was verified. Stale-price rejection is tested; a dedicated sequencer outage/recovery guard is **not configured or validated**. This remains a launch-readiness item, not a passed oracle check.
- This fork test verifies the oracle path through the final NFT/treasury contracts. The separate stock fork report covers stock swaps and Sunday settlement; this test does not imply the full application is deployed or launch-ready.

Sources: [Robinhood oracle integration](https://docs.robinhood.com/chain/oracles-and-price-feeds/), [Chainlink price-feed directory](https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood), [feed directory JSON](https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json), [Chainlink sequencer uptime-feed availability](https://docs.chain.link/data-feeds/l2-sequencer-feeds).

## Production ETH/USD oracle verification - 5 October 2026

The existing EthUsdOracleV6 adapter was reused with Robinhood mainnet Chainlink proxy 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9 and connected to a newly deployed final RentTreasury on an isolated fork. Zero round IDs are now rejected. Six oracle unit tests and all eighteen stock/protocol regression tests passed (24 total). The real-feed fork at source block 80926554, local chain 31337, passed all 6 check groups: feed identity, decimal/timestamp preservation, ETH rent conversions, seven-day funding and lighting, valuation changes/top-ups, NFT purchase accounting, atomic stale-price rejection and seller-proceeds withdrawals during stale pricing. Tested source hashes match the final source.

Evidence: apps/packages/contracts/deployments/oracle-fork/result.json. Configuration: apps/packages/contracts/config/robinhood-eth-usd.json. Deployment wiring, rerun commands and operational limits: apps/packages/contracts/ORACLE_INTEGRATION.md. This supersedes the earlier statement that the production price adapter had not been tested; live adapter/treasury deployment is still pending. No live transaction or deployment occurred. Frontend files were unchanged in this oracle update.

The existing 24-hour freshness guard is verified. A feed heartbeat delayed beyond that limit temporarily blocks price-dependent actions, including top-ups. A dedicated Robinhood sequencer-outage/recovery guard remains unconfigured and unverified: no official Robinhood uptime-feed address was found in Chainlink's supported-network list. This test does not establish complete mainnet launch readiness.


## Public testnet follow-up — 6 October 2026

The replacement public testnet suite uses EthUsdOracleV6 with the explicitly synthetic TestnetChainlinkFeed ($2,500 ETH/USD). This tests the adapter interface without pretending the mainnet Chainlink proxy exists on testnet. Mainnet feed verification remains the isolated real-feed fork report above; no mainnet deployment was performed.
