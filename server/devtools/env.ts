import fs from "fs";
import path from "path";

// Imported first by seed.ts. With --file the dev host skips the manifest, so
// it never sets APP_ID; Taproot uses the App ID as its own member ID (ticket
// and staff channel access rules), so read it from the manifest here.
if (!process.env.APP_ID) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../root-manifest.json"), "utf8")) as { id: string };
  process.env.APP_ID = manifest.id;
}
