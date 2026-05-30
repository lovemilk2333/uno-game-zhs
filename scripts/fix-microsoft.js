#!/usr/bin/env node
import { $ } from "zx";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

/**
 * Build a VS_VERSION_INFO String node (wLength, wValueLength, wType=1, szKey, padding, Value).
 * @param {string} key
 * @param {string} val
 * @returns {Buffer}
 */
function makeStringNode(key, val) {
  const kBuf = Buffer.from(key + "\0", "utf16le");
  const vBuf = Buffer.from(val + "\0", "utf16le");
  const headLen = 6 + kBuf.length;
  const padding = (4 - (headLen % 4)) % 4;
  const totalLen = headLen + padding + vBuf.length;

  const node = Buffer.alloc(totalLen);
  node.writeUInt16LE(totalLen, 0); // wLength
  node.writeUInt16LE(vBuf.length / 2, 2); // wValueLength (in WCHARs)
  node.writeUInt16LE(1, 4); // wType = text
  kBuf.copy(node, 6);
  vBuf.copy(node, headLen + padding);
  return node;
}

/**
 * Syncs PE file version headers and aligns internal string structures.
 * Embeds LegalCopyright by over-allocating via a padded ProductName, then
 * binary-patching the result to fit both nodes in the reserved space.
 * @param {string} exePath - Path to the target executable.
 */
export async function syncExeVersion(exePath) {
  if (!exePath) throw new Error("Error: Please specify target exe file.");

  // --- Extract fields from package.json ---
  const vi = pkg.pefile["version-info"];
  let ver = pkg.version;
  if (ver.split(".").length === 3) ver += ".0";

  const company = vi.CompanyName;
  const realProduct = vi.ProductName;
  const desc = vi.FileDescription;
  const orig = vi.OriginalFilename;
  const internal = vi.InternalName;
  const copyright = vi.LegalCopyright;

  // Pad ProductName to force resedit to allocate a large block
  const fakeProduct = realProduct + "_".repeat(100);

  // --- Step 1: Run resedit-cli with the oversized ProductName ---
  console.log("Step 1: Forcing resedit-cli to stretch PE allocation space...");
  await $`pnpm resedit \
    --in ${exePath} \
    --out ${exePath} \
    --file-version ${ver} \
    --product-version ${ver} \
    --company-name ${company} \
    --product-name ${fakeProduct} \
    --file-description ${desc} \
    --original-filename ${orig} \
    --internal-name ${internal}`;

  // --- Step 2: Binary-patch the PE to replace the fake node ---
  console.log("Step 2: Executing ultimate twin-node discrete alignment...");
  const data = Buffer.from(await fs.readFile(exePath));

  const targetBytes = Buffer.from(fakeProduct, "utf16le");
  const keyBytes = Buffer.from("ProductName\0", "utf16le");

  const offset = data.indexOf(targetBytes);
  if (offset === -1) throw new Error("[CRITICAL] Target mapping block track lost.");

  // Walk backwards from the value to find the node header (key precedes value)
  let nodeOffset = -1;
  for (let i = offset; i > Math.max(0, offset - 200); i--) {
    if (data.subarray(i, i + keyBytes.length).equals(keyBytes)) {
      nodeOffset = i - 6;
      break;
    }
  }
  if (nodeOffset === -1) throw new Error("[CRITICAL] Node architecture unlocatable.");

  const originalNodeLen = data.readUInt16LE(nodeOffset);
  console.log(`[OK] Located target zone, full length: ${originalNodeLen} bytes.`);

  // Build compact replacement nodes
  const nodeProd = makeStringNode("ProductName", realProduct);
  const nodeCopy = makeStringNode("LegalCopyright", copyright);

  const prodLen = nodeProd.length;
  const prodPadding = (4 - (prodLen % 4)) % 4;
  const prodTotalRequired = prodLen + prodPadding;

  // Give all remaining space to the LegalCopyright node
  const copyTotalAllocated = originalNodeLen - prodTotalRequired;
  nodeCopy.writeUInt16LE(copyTotalAllocated, 0);

  // Lay out both nodes contiguously
  const newBlock = Buffer.alloc(originalNodeLen);
  nodeProd.copy(newBlock, 0);
  nodeCopy.copy(newBlock, prodTotalRequired);

  // In-place overwrite
  newBlock.copy(data, nodeOffset);

  await fs.writeFile(exePath, data);
  console.log(
    `[SUCCESS] Disjoint twin-node alignment fully synced. Total ${originalNodeLen} bytes balanced.`,
  );
}

if (import.meta.main) {
  try {
    await syncExeVersion(process.argv[2]);
    console.log("All elements fully finalized and cross-locked.");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
