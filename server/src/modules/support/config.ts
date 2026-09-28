import { moduleConfig, saveModuleConfig } from "../../settings";

// The support module's settings, stored under "module:support".

export type TranscriptMode = "full" | "summary" | "off";

export interface SupportConfig {
  tickets: {
    enabled: boolean;
    /** Channel group new ticket channels are created in. */
    channelGroupId: string | null;
    /** Roles that see every ticket. Empty = roles with kick/ban/admin permissions. */
    staffRoleIds: string[];
    maxOpen: number;
    /** Where openings, closings and transcripts are posted. */
    logChannelId: string | null;
    transcriptMode: TranscriptMode;
    welcomeMessage: string;
    pingStaff: boolean;
    /** Days a closed ticket's transcript is kept; 0 = until deleted. */
    retentionDays: number;
    panel: {
      channelId: string | null;
      messageId: string | null;
      /** Reaction shortcode as Root reports it (":ticket:" or ":name:id:"). */
      emoji: string;
    };
  };
  /** Taproot's own member ID, learned from messages it posts. */
  selfUserId: string | null;
}

export const NAME = "support";

export const DEFAULT_WELCOME =
  "Hi {user}, thanks for opening a ticket! Tell us what's going on and a staff member will be with you soon.\n\n**Topic:** {topic}";

export const DEFAULTS: SupportConfig = {
  tickets: {
    enabled: false,
    channelGroupId: null,
    staffRoleIds: [],
    maxOpen: 1,
    logChannelId: null,
    transcriptMode: "full",
    welcomeMessage: DEFAULT_WELCOME,
    pingStaff: false,
    retentionDays: 90,
    panel: { channelId: null, messageId: null, emoji: ":ticket:" },
  },
  selfUserId: null,
};

export function config(): SupportConfig {
  return moduleConfig<SupportConfig>(NAME);
}

/** Applies a change to a copy of the config and saves it. */
export async function updateConfig(change: (c: SupportConfig) => void): Promise<void> {
  const next = structuredClone(config());
  change(next);
  await saveModuleConfig(NAME, next, "support:config");
}
