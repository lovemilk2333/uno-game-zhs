// Shared test helpers: each test file that needs a real server starts its
// own forked instance on a unique port so files can run in parallel without
// port conflicts.  Ports are statically assigned per file — just pick a
// unique 4-digit port that no other test file uses.

import { fork } from "child_process";
import path from "path";

let serverProcess = null;

/**
 * Fork `dist/server.cjs` on `port` and wait for the "Server started" line.
 * Returns the port (resolves once the server is ready).
 */
export async function startServer(port) {
  const serverPath = path.resolve("dist/server.cjs");
  return new Promise((resolve, reject) => {
    const proc = fork(serverPath, ["--port", String(port)], {
      env: { ...process.env, NODE_ENV: "development" },
      stdio: "pipe",
    });
    serverProcess = proc;

    const timeout = setTimeout(() => {
      reject(new Error(`Server start timeout on port ${port}`));
    }, 15000);

    proc.stdout.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("Server started")) {
        clearTimeout(timeout);
        resolve(port);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Kill the forked server if it is still running. */
export function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}
