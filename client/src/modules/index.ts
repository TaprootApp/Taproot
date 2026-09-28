import type { ClientModule, ModulePage } from "./types";
import { module as logs } from "./logs";
import { module as utility } from "./utility";
import { module as automodplus } from "./automodplus";
import { module as modtools } from "./modtools";
import { module as engagement } from "./engagement";
import { module as events } from "./events";
import { module as support } from "./support";
import { module as feeds } from "./feeds";

export const MODULES: ClientModule[] = [logs, utility, automodplus, modtools, engagement, events, support, feeds];

export const MODULE_PAGES: ModulePage[] = MODULES.flatMap((m) => m.pages ?? []);

export const MODULE_ME_SECTIONS = MODULES.flatMap((m) => m.meSections ?? []);
