import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { stringToHex } from "viem";

const execFileAsync = promisify(execFile);

function normalize(svg: string) {
  return svg.replace(/<!--.*?-->/gs, "").replace(/>\s+</g, "><").trim();
}

describe("DEEDZ canonical artwork", () => {
  it("matches the approved SVG generator", async () => {
    const { viem } = await network.create();
    const art = await viem.deployContract("DeedArtV6");
    const uri = await art.read.render([{
      ticker: stringToHex("NVDA", { size: 32 }), serial: 84n, lit: false,
      price: 0n, runway: 0n, fused: false, throne: false, lifetime: 0n,
    }]);
    const metadata = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
    const rendered = Buffer.from(metadata.image.split(",")[1], "base64").toString();
    const generator = new URL("../../../web/scripts/generate-deed-svg.mjs", import.meta.url);
    const { stdout } = await execFileAsync(process.execPath, [generator.pathname.slice(1), "--state", "dark", "--ticker", "NVDA", "--serial", "84", "--allocation", "250", "--stdout", "true"]);
    assert.equal(normalize(rendered), normalize(stdout));
  });
});
