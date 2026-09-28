import type { TaprootModule } from "../types";
import { initAfk } from "./afk";
import { initAutoresponders } from "./autoresponder";
import { registerFun } from "./fun";
import { initHighlights } from "./highlights";
import { registerInfo } from "./info";
import { utilityService } from "./service";
import { NAME } from "./shared";

// Utility module: info commands (whois, serverinfo, roleinfo, avatar,
// membercount, channelinfo), AFK, fun commands, autoresponders and keyword
// highlights. Tables are prefixed "utility_".
export const module: TaprootModule = {
  name: NAME,
  async init() {
    registerInfo();
    registerFun();
    await initAfk();
    await initAutoresponders();
    await initHighlights();
  },
  services: [utilityService],
};
