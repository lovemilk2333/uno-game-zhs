#!/usr/bin/env node
import { ensureBinDir, buildAndPack } from "./build-exe.js";
import { $ } from "zx";
$.verbose = true; // Turn verbosity back on for direct CLI execution

await ensureBinDir();
await buildAndPack("node12", "win", "x64");
await buildAndPack("node12", "linux", "arm64");
await buildAndPack("node12", "linux", "x64");
