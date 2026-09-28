// DEV ONLY. Writes root-manifest.seed.json (git-ignored) for `npm run seed`:
// the dev manifest from scripts/dev-manifest.js, launching the seed instead of
// Taproot, plus Create Channel Group so the seed can build the demo channel
// groups. The dev host only reads a manifest (and uploads its permissions)
// when it launches the manifest's own entry file; with --file it skips the
// manifest entirely. The next `npm run server` uploads Taproot's normal
// permissions again, dropping the extra one.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "root-manifest.dev.json"), "utf8"));
manifest.package.server.launch = "server/devtools-dist/devtools/seed.js";
manifest.permissions.community.createChannelGroup = true;
manifest.permissions.community.communityCreateChannelGroup = true;
fs.writeFileSync(path.join(root, "root-manifest.seed.json"), JSON.stringify(manifest, null, 2) + "\n");
