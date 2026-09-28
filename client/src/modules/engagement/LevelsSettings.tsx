import React from "react";
import type { EngagementLevelsSettings } from "@taproot/gen-shared";
import { engagementServiceClient } from "@taproot/gen-client";
import {
  Banner,
  Button,
  Card,
  ChannelMultiSelect,
  ChannelSelect,
  Field,
  IconButton,
  MessagePreview,
  NumberInput,
  PageHeader,
  RoleMultiSelect,
  RoleSelect,
  Select,
  Stack,
  TextArea,
  Toggle,
} from "../../components";
import { useSession } from "../../lib";
import { DraftGate, DraftNotices, DraftSaveBar, useSettingsDraft } from "./shared";
import styles from "./engagement.module.css";

// Levels settings (admins). Same limits as validateLevels in
// server/src/modules/engagement/logic.ts; the server re-checks everything.

const MAX_REWARDS = 50;
const MAX_MULTIPLIERS = 25;

function problems(s: EngagementLevelsSettings): string | undefined {
  if (s.xpMin < 1 || s.xpMax > 1000 || s.xpMin > s.xpMax) return "XP per message: the minimum can't be above the maximum (1 to 1000).";
  if (s.cooldownSeconds < 0 || s.cooldownSeconds > 3600) return "The cooldown must be 0 to 3600 seconds.";
  if (s.announce === "channel" && !s.announceChannelId) return "Pick the channel for level-up announcements.";
  if (s.announce !== "off" && !s.announceMessage.trim()) return "Write the level-up message.";
  if (s.rewards.some((r) => !r.roleId)) return "Pick a role for every reward.";
  if (s.multipliers.some((m) => !m.roleId)) return "Pick a role for every multiplier.";
  if (new Set(s.multipliers.map((m) => m.roleId)).size !== s.multipliers.length) return "A role can only have one multiplier.";
  return undefined;
}

/** What the announcement looks like, with sample values filled in. */
function sample(message: string, name: string, level: number): string {
  return message
    .replace(/\{user\}/gi, `[@${name}](root://user/you)`)
    .replace(/\{user\.name\}/gi, name)
    .replace(/\{level\}/gi, String(level));
}

const LevelsSettings: React.FC = () => {
  const { session } = useSession();
  const form = useSettingsDraft("levels", (levels) => engagementServiceClient.saveLevels(levels));

  return (
    <Stack>
      <PageHeader
        title="Levels"
        description="Members earn XP for chatting, level up, and can earn roles along the way."
      />
      <DraftGate form={form}>
        {(s) => {
          const patch = (change: Partial<EngagementLevelsSettings>) => form.patch(change);
          const invalid = problems(s);
          return (
            <>
              <DraftNotices form={form} />
              <Card>
                <Toggle
                  checked={s.enabled}
                  onChange={(enabled) => patch({ enabled })}
                  label="Levels"
                  description={`Earn XP by chatting. Members check with ${session.prefix}rank and ${session.prefix}levels.`}
                />
              </Card>

              <Card title="XP" description="Each message earns a random amount, at most once per cooldown. Commands and bots never earn XP.">
                <Stack gap={12}>
                  <div className={styles.editorRow}>
                    <Field label="Minimum per message">
                      <NumberInput value={s.xpMin} onChange={(xpMin) => patch({ xpMin })} min={1} max={1000} suffix="XP" />
                    </Field>
                    <Field label="Maximum per message">
                      <NumberInput value={s.xpMax} onChange={(xpMax) => patch({ xpMax })} min={1} max={1000} suffix="XP" />
                    </Field>
                    <Field label="Cooldown">
                      <NumberInput
                        value={s.cooldownSeconds}
                        onChange={(cooldownSeconds) => patch({ cooldownSeconds })}
                        min={0}
                        max={3600}
                        suffix="seconds"
                      />
                    </Field>
                  </div>
                  <p className={styles.muted}>
                    Level <em>L</em> to <em>L</em>+1 takes 5L² + 50L + 100 XP: 100 XP for level 1, 1,100 more for level 11.
                  </p>
                </Stack>
              </Card>

              <Card title="Level-up message">
                <Stack gap={12}>
                  <Field label="Announce level-ups">
                    <Select<string>
                      value={s.announce}
                      onChange={(announce) => patch({ announce })}
                      options={[
                        { value: "off", label: "Don't announce" },
                        { value: "current", label: "In the channel where they levelled up" },
                        { value: "channel", label: "In a specific channel" },
                      ]}
                    />
                  </Field>
                  {s.announce === "channel" && (
                    <Field label="Channel">
                      <ChannelSelect
                        value={s.announceChannelId || undefined}
                        onChange={(id) => patch({ announceChannelId: id ?? "" })}
                      />
                    </Field>
                  )}
                  {s.announce !== "off" && (
                    <>
                      <Field label="Message" help="{user} mentions the member, {user.name} is their name, {level} is the new level.">
                        <TextArea
                          value={s.announceMessage}
                          onChange={(announceMessage) => patch({ announceMessage })}
                          maxLength={1000}
                          rows={2}
                        />
                      </Field>
                      <MessagePreview content={sample(s.announceMessage, session.nickname || "Member", 5)} author="Taproot" />
                    </>
                  )}
                </Stack>
              </Card>

              <Card
                title="Role rewards"
                description="Roles given when a member reaches a level. Staff roles can't be rewards."
                actions={
                  <Button
                    size="sm"
                    icon="plus"
                    disabled={s.rewards.length >= MAX_REWARDS}
                    onClick={() => {
                      const top = s.rewards.reduce((m, r) => Math.max(m, r.level), 0);
                      patch({ rewards: [...s.rewards, { level: top + 5, roleId: "" }] });
                    }}
                  >
                    Add reward
                  </Button>
                }
              >
                <Stack gap={10}>
                  {s.rewards.length === 0 && <span className={styles.muted}>No rewards yet.</span>}
                  {s.rewards.map((r, i) => (
                    <div key={i} className={styles.editorRow}>
                      <NumberInput
                        value={r.level}
                        onChange={(level) => patch({ rewards: s.rewards.map((x, j) => (j === i ? { ...x, level } : x)) })}
                        min={1}
                        max={1000}
                        width={80}
                        suffix="→"
                      />
                      <div className={styles.grow}>
                        <RoleSelect
                          value={r.roleId || undefined}
                          excludePrivileged
                          onChange={(roleId) => patch({ rewards: s.rewards.map((x, j) => (j === i ? { ...x, roleId: roleId ?? "" } : x)) })}
                        />
                      </div>
                      <IconButton
                        icon="trash"
                        label="Remove reward"
                        danger
                        onClick={() => patch({ rewards: s.rewards.filter((_, j) => j !== i) })}
                      />
                    </div>
                  ))}
                  <Field label="When a member has several rewards">
                    <Select<string>
                      value={s.rewardMode}
                      onChange={(rewardMode) => patch({ rewardMode })}
                      options={[
                        { value: "stack", label: "Keep them all (stack)" },
                        { value: "highest", label: "Keep only the highest level's role" },
                      ]}
                    />
                  </Field>
                  <p className={styles.muted}>
                    Taproot's role must be above reward roles in Root's role list, or it can't hand them out. Failures are
                    reported in the mod log.
                  </p>
                </Stack>
              </Card>

              <Card
                title="XP multipliers"
                description="Members with these roles earn more (or less) XP. If a member has several, the highest applies."
                actions={
                  <Button
                    size="sm"
                    icon="plus"
                    disabled={s.multipliers.length >= MAX_MULTIPLIERS}
                    onClick={() => patch({ multipliers: [...s.multipliers, { roleId: "", multiplier: 1.5 }] })}
                  >
                    Add multiplier
                  </Button>
                }
              >
                <Stack gap={10}>
                  {s.multipliers.length === 0 && <span className={styles.muted}>No multipliers.</span>}
                  {s.multipliers.map((m, i) => (
                    <div key={i} className={styles.editorRow}>
                      <div className={styles.grow}>
                        <RoleSelect
                          value={m.roleId || undefined}
                          onChange={(roleId) =>
                            patch({ multipliers: s.multipliers.map((x, j) => (j === i ? { ...x, roleId: roleId ?? "" } : x)) })
                          }
                        />
                      </div>
                      <NumberInput
                        value={m.multiplier}
                        onChange={(multiplier) => patch({ multipliers: s.multipliers.map((x, j) => (j === i ? { ...x, multiplier } : x)) })}
                        min={0.1}
                        max={10}
                        step={0.1}
                        suffix="×"
                      />
                      <IconButton
                        icon="trash"
                        label="Remove multiplier"
                        danger
                        onClick={() => patch({ multipliers: s.multipliers.filter((_, j) => j !== i) })}
                      />
                    </div>
                  ))}
                </Stack>
              </Card>

              <Card title="No XP" description="Messages in these channels, or from members with these roles, never earn XP.">
                <Stack gap={12}>
                  <Field label="Channels">
                    <ChannelMultiSelect
                      value={s.noXpChannelIds}
                      onChange={(noXpChannelIds) => patch({ noXpChannelIds })}
                      emptyText="XP is earned everywhere"
                    />
                  </Field>
                  <Field label="Roles">
                    <RoleMultiSelect value={s.noXpRoleIds} onChange={(noXpRoleIds) => patch({ noXpRoleIds })} emptyText="No roles excluded" />
                  </Field>
                </Stack>
              </Card>

              {!s.enabled && (
                <Banner tone="info">Levels are off. Settings are kept, and XP starts counting when you switch them on and save.</Banner>
              )}
              <DraftSaveBar form={form} invalid={invalid} />
            </>
          );
        }}
      </DraftGate>
    </Stack>
  );
};

export default LevelsSettings;
