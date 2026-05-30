// Copy static assets from public/ into dist/, cross-platform.
// Replaces the Unix `cp` calls in the build script so it works on Windows too.
//
// Implementation note: avoids fs.cpSync because it only landed in Node 16.7
// and we still build with Node 12 to produce a pkg binary that runs on Win 7.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const distDir = path.join(root, "dist");

function copyFileSync(src, dst) {
  fs.writeFileSync(dst, fs.readFileSync(src));
}

function copyRecursiveSync(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    copyFileSync(src, dst);
  }
}

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const assets = [
  { from: path.join(publicDir, "index.html"), to: path.join(distDir, "index.html") },
  { from: path.join(publicDir, "style.css"), to: path.join(distDir, "style.css") },
  { from: path.join(publicDir, "icons"), to: path.join(distDir, "icons"), recursive: true },
];

for (const { from, to, recursive } of assets) {
  if (recursive) {
    copyRecursiveSync(from, to);
  } else {
    copyFileSync(from, to);
  }
  console.log(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}
