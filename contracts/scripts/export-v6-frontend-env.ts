import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const manifestSetting = process.env.V6_CANDIDATE_MANIFEST;
const outputSetting = process.env.V6_FRONTEND_ENV;
if (!manifestSetting || !outputSetting) throw new Error("Set V6_CANDIDATE_MANIFEST and V6_FRONTEND_ENV");
const manifestPath = resolve(process.cwd(), manifestSetting);
const outputPath = resolve(process.cwd(), outputSetting);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!["candidate-deployed-not-launched", "candidate-launched-unaudited", "production-approved"].includes(manifest.status)) {
  throw new Error(`Manifest status ${manifest.status} is not valid for a frontend release`);
}
const requested = process.env.V6_FRONTEND_RELEASE ?? "candidate";
if (requested !== "candidate" && requested !== "production") throw new Error("V6_FRONTEND_RELEASE must be candidate or production");
if (requested === "production" && (manifest.chainId !== 4663 || manifest.status !== "production-approved")) {
  throw new Error("Production frontend export requires a chain-4663 production-approved manifest");
}
if (requested === "candidate" && manifest.chainId !== 46630) throw new Error("Candidate frontend export requires chain 46630");

const c = manifest.contracts;
const required = ["rent", "oracle", "geoGate", "vault", "deed", "rentHook", "feeRouter", "rewards", "ledger", "emitter", "throneAuction"];
for (const name of required) if (!c?.[name]) throw new Error(`Manifest is missing contracts.${name}`);
if (!manifest.external?.poolManager || !manifest.external?.stateView || !manifest.uniswapV4?.poolId) throw new Error("Manifest is missing Uniswap v4 configuration");

const values: Record<string, string | number> = {
  NEXT_PUBLIC_V6_RELEASE: requested,
  NEXT_PUBLIC_V6_CHAIN_ID: manifest.chainId,
  NEXT_PUBLIC_V6_RENT: c.rent,
  NEXT_PUBLIC_V6_ORACLE: c.oracle,
  NEXT_PUBLIC_V6_GATE: c.geoGate,
  NEXT_PUBLIC_V6_VAULT: c.vault,
  NEXT_PUBLIC_V6_DEED: c.deed,
  NEXT_PUBLIC_V6_POOL_MANAGER: manifest.external.poolManager,
  NEXT_PUBLIC_V6_STATE_VIEW: manifest.external.stateView,
  NEXT_PUBLIC_V6_RENT_HOOK: c.rentHook,
  NEXT_PUBLIC_V6_FEE_ROUTER: c.feeRouter,
  NEXT_PUBLIC_V6_POOL_ID: manifest.uniswapV4.poolId,
  NEXT_PUBLIC_V6_POOL_FEE: 500,
  NEXT_PUBLIC_V6_TICK_SPACING: manifest.uniswapV4.poolKey.tickSpacing,
  NEXT_PUBLIC_V6_DEPLOYED_BLOCK: manifest.deployedAtBlock,
  NEXT_PUBLIC_V6_REWARDS: c.rewards,
  NEXT_PUBLIC_V6_LEDGER: c.ledger,
  NEXT_PUBLIC_V6_EMITTER: c.emitter,
  NEXT_PUBLIC_V6_THRONE_AUCTION: c.throneAuction,
};
const body = `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
await writeFile(outputPath, body, { flag: process.env.V6_OVERWRITE_FRONTEND_ENV === "YES" ? "w" : "wx" });
console.log(`Frontend environment written to ${outputPath}`);
console.log("NEXT_PUBLIC values contain public deployment data only. Rebuild Next.js after changing them.");
