// Writes root-manifest.dev.json for local testing with the dev host.
//
// Root's dev host (@rootsdk/dev-tools 0.21.3) copies the manifest's
// "permissions" block as-is into Root's permission message, whose fields are
// named communityKick, channelCreateMessage and so on. The manifest's own names
// (kick, createMessage) don't match, so every permission is silently dropped
// and Taproot runs with none. This copy adds the prefixed names alongside the
// originals. The real root-manifest.json is left untouched for packaging.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "root-manifest.json"), "utf8"));

function withPrefixedNames(perms, prefix) {
  const out = { ...perms };
  for (const [key, value] of Object.entries(perms ?? {})) {
    out[prefix + key[0].toUpperCase() + key.slice(1)] = value;
  }
  return out;
}

if (manifest.permissions) {
  manifest.permissions = {
    community: withPrefixedNames(manifest.permissions.community, "community"),
    channel: withPrefixedNames(manifest.permissions.channel, "channel"),
  };
}

fs.writeFileSync(path.join(root, "root-manifest.dev.json"), JSON.stringify(manifest, null, 2) + "\n");
