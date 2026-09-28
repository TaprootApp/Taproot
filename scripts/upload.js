// Builds and uploads the package for the version in root-manifest.json.
// The upload token is read from AUTH_TOKEN in server/.env (generated in the
// Root Developer Portal) and passed straight to the CLI, never printed.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const env = fs.readFileSync(path.join(root, "server", ".env"), "utf8");
const token = /^AUTH_TOKEN=(.+)$/m.exec(env)?.[1]?.trim();
if (!token) {
  console.error("No AUTH_TOKEN in server/.env. Generate one in the Root Developer Portal first.");
  process.exit(1);
}

const { version } = JSON.parse(fs.readFileSync(path.join(root, "root-manifest.json"), "utf8"));
const file = `rootapp-${version.replace(/\./g, "-")}.pkg`;
// Root's upload CLI echoes its arguments, token included, so output is
// captured and the token masked before printing.
const run = (args) => {
  let out;
  try {
    out = execFileSync("npx", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    process.stdout.write(out.split(token).join("<token>"));
    process.exit(1);
  }
  process.stdout.write(out.split(token).join("<token>"));
  return out;
};

run(["rootsdk", "build", "package"]);
console.log(`Uploading ${file}...`);
const result = run(["rootsdk", "upload", "package", "--file", `./${file}`, "--authToken", token]);
// The CLI exits 0 even when Root rejects the upload; the result code tells.
if (!/App Push result: 0\b/.test(result)) process.exit(1);
