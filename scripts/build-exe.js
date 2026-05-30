#!/usr/bin/env node
import { $ } from "zx";
import * as path from "node:path";
import { arch, platform } from "node:os";
import { syncExeVersion } from "./fix-microsoft.js";

const BIN_DIR = "bin/";

let is_windows = false; // we assume no windows by default

const XPLATF = (() => {
  switch (platform()) {
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    case "win32":
      is_windows = true;
      return "win";
  }
})();

const XBTW = (() => {
  return arch();
})();

export async function ensureBinDir() {
  await $`mkdir -p bin/`;
}

export async function build(runtime, platform, arch) {
  const target = `node12-${platform}-${arch}`;
  const outfile = path.join(BIN_DIR, `${platform}/uno-server` + ["", ".exe"][+(platform == "win")]);
  console.log("building for", target);
  await $`pnpm dlx pkg . --targets ${target} --output ${outfile} --public`;
  if (platform == "win") {
    await syncExeVersion(outfile);
  }
  return outfile;
}

export async function buildAndPack(runtime, platform, arch) {
  const outfile = await build(runtime, platform, arch);
  const {
    default: { version },
  } = await import("../package.json", {
    with: { type: "json" },
  });

  const target = `release/UNO-v${version}_${platform}_${arch}.zip`;
  // ${VERSION}_${PLATFORM}_${ARCH}
  await $`mkdir -p release`;
  await $`zip ${target} -j ${outfile}`;
}

if (import.meta.main) {
  await ensureBinDir();
  await build("node12", process.argv?.[2] || XPLATF, process.argv?.[3] || XBTW);
}
