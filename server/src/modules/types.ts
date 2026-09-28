import type { RootServerService } from "@rootsdk/server-app";

// Feature modules plug into the server without editing core files. Each lives
// in server/src/modules/<name>/ and exports `module: TaprootModule` from its
// index.ts; server/src/modules/index.ts lists them and main.ts starts them
// after the database, settings and core features are ready.

export interface TaprootModule {
  name: string;
  /** Create tables (CREATE TABLE IF NOT EXISTS), load config, register commands,
   *  message filters/listeners, jobs and event handlers. Must not throw for
   *  expected conditions; an error here is logged and the module is skipped. */
  init(): Promise<void>;
  /** GUI services for this module's own proto file. */
  services?: RootServerService[];
}
