import React from "react";
import type { AutomodRules } from "@taproot/gen-shared";
import { configServiceClient } from "@taproot/gen-client";
import styles from "./Settings.module.css";
import { Banner, Card, ChannelMultiSelect, Field, NumberInput, PageHeader, Section, Stack, Toggle } from "../../components";
import { plural } from "../../lib";
import { FormGate, FormNotices, TagList, firstError, useConfigForm } from "./shared";
import {
  ExtraFilterCards,
  RuleActions,
  extrasErrors,
  saveExtras,
  useAutomodExtras,
} from "../../modules/automodplus/AutomodExtras";
import { DraftNotices, UnsavedBar } from "../../modules/automodplus/shared";

// Auto-mod rules (!automod, !automodset, !badword, !allowlink). Limits match
// updateAutomod in server/src/services/configService.ts: every number is a
// whole number above 0, duplicates at least 2, caps percent at most 100.
//
// The automodplus module adds each rule's action (warn, mute, kick, ban, a
// custom notice, a log channel, exemptions) and the extra filters. Those are
// a second form saved through its own service; one Save bar saves both.

/** Splits and lowercases like !badword. */
function parseWords(text: string): string[] | string {
  const words = text
    .split(/[\s,]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  if (words.some((w) => /^\*+$/.test(w))) return "A word needs at least one letter besides *.";
  return words;
}

/** Same as normalizeDomain in server/src/features/automod.ts, one or more at a time. */
function parseDomains(text: string): string[] | string {
  const out: string[] = [];
  for (const input of text.split(/[\s,]+/).filter(Boolean)) {
    const domain = input.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    if (!domain.includes(".")) return `"${input}" isn't a domain. Use something like youtube.com.`;
    out.push(domain);
  }
  return out;
}

function numberErrors(r: AutomodRules): Record<string, string | undefined> {
  const positive = (n: number, name: string) =>
    Number.isInteger(n) && n >= 1 ? undefined : `${name} must be a whole number above 0.`;
  return {
    maxMentions: positive(r.maxMentions, "Max mentions"),
    spamMessages: positive(r.spamMessages, "Spam messages"),
    spamSeconds: positive(r.spamSeconds, "Spam seconds"),
    spamDuplicates: positive(r.spamDuplicates, "Duplicates") ?? (r.spamDuplicates < 2 ? "Duplicates must be at least 2." : undefined),
    capsPercent: positive(r.capsPercent, "Caps percent") ?? (r.capsPercent > 100 ? "Caps percent must be 100 or less." : undefined),
    capsMinLength: positive(r.capsMinLength, "Caps minimum length"),
    strikeCount: positive(r.strikeCount, "Strike count"),
    strikeWindowMinutes: positive(r.strikeWindowMinutes, "Strike window"),
    strikeMuteMinutes: positive(r.strikeMuteMinutes, "Mute time"),
  };
}

/** A rule's card: its on/off switch sits in the header, and the body dims while off. */
const RuleCard: React.FC<{
  title: string;
  description: React.ReactNode;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  /** Rule settings footer (actions, exemptions), shown under the rule's own fields. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, enabled, onToggle, footer, children }) => (
  <Card title={title} description={description} actions={<Toggle checked={enabled} onChange={onToggle} ariaLabel={`${title} on/off`} />}>
    <div className={enabled ? undefined : styles.dimmed}>
      {children}
      {footer}
    </div>
  </Card>
);

const Automod: React.FC = () => {
  const form = useConfigForm("automod");
  const extras = useAutomodExtras();
  const [saving, setSaving] = React.useState(false);

  return (
    <Stack>
      <PageHeader title="Auto-mod" description="Delete rule-breaking messages automatically and mute repeat offenders." />
      <FormGate form={form}>
        {(r) => {
          const errors = numberErrors(r);
          const patch = (change: Partial<AutomodRules>) => form.patch(change);
          const actions = (rule: string) => <RuleActions form={extras} rule={rule} />;
          const invalid = firstError(errors) ?? firstError(extrasErrors(extras.draft));
          const save = async () => {
            setSaving(true);
            try {
              if (form.dirty && !(await form.save((d) => configServiceClient.updateAutomod(d)))) return;
              if (extras.dirty) await saveExtras(extras);
            } finally {
              setSaving(false);
            }
          };
          return (
            <>
              <FormNotices form={form} />
              <DraftNotices form={extras} />
              <Card>
                <Stack gap={12}>
                  <Toggle
                    checked={r.enabled}
                    onChange={(enabled) => patch({ enabled })}
                    label="Auto-mod"
                    description="Master switch. When it's off, none of the rules below run."
                  />
                  <p className={styles.hint}>
                    Staff are never filtered, and neither is anyone (or any role) in the{" "}
                    <strong>Exempt from auto-mod</strong> picker on Taproot's page in Root's community settings.
                  </p>
                </Stack>
              </Card>
              {!r.enabled && (
                <Banner tone="warning" title="Auto-mod is off">
                  You can still set the rules up; they start working when you switch auto-mod on and save.
                </Banner>
              )}

              <RuleCard
                title="Blocked words"
                footer={actions("words")}
                description="Deletes messages containing any of these words."
                enabled={r.wordsEnabled}
                onToggle={(wordsEnabled) => patch({ wordsEnabled })}
              >
                <Stack gap={10}>
                  <TagList
                    value={r.words}
                    onChange={(words) => patch({ words })}
                    parse={parseWords}
                    placeholder="Add words, separated by spaces or commas"
                    emptyText="No blocked words"
                    mono
                  />
                  <p className={styles.hint}>
                    Words match whole words, ignoring case and common swaps like <code>0</code> for <code>o</code>. Put a{" "}
                    <code>*</code> at the start or end to match part of a word: <code>spam*</code> also catches "spammer".
                  </p>
                </Stack>
              </RuleCard>

              <RuleCard
                title="Links"
                footer={actions("links")}
                description="Deletes messages with links, except to the domains allowed here."
                enabled={r.linksEnabled}
                onToggle={(linksEnabled) => patch({ linksEnabled })}
              >
                <Stack gap={10}>
                  <TagList
                    value={r.allowedDomains}
                    onChange={(allowedDomains) => patch({ allowedDomains })}
                    parse={parseDomains}
                    placeholder="e.g. youtube.com"
                    emptyText="No allowed domains: every link is removed"
                    mono
                  />
                  <p className={styles.hint}>Allowing a domain also allows its subdomains (youtube.com covers www.youtube.com).</p>
                </Stack>
              </RuleCard>

              <RuleCard
                title="Mass mentions"
                footer={actions("mentions")}
                description="Deletes messages that mention too many people at once."
                enabled={r.mentionsEnabled}
                onToggle={(mentionsEnabled) => patch({ mentionsEnabled })}
              >
                <Stack gap={12}>
                  <Field label="Most mentions allowed in one message" error={errors.maxMentions}>
                    <NumberInput value={r.maxMentions} onChange={(maxMentions) => patch({ maxMentions })} min={1} suffix="mentions" />
                  </Field>
                  <Toggle
                    checked={r.blockAllMentions}
                    onChange={(blockAllMentions) => patch({ blockAllMentions })}
                    label="Block @All and @Here"
                    description="Members' messages that ping everyone are removed."
                  />
                </Stack>
              </RuleCard>

              <RuleCard
                title="Spam"
                footer={actions("spam")}
                description="Deletes messages sent too fast, and the same message repeated."
                enabled={r.spamEnabled}
                onToggle={(spamEnabled) => patch({ spamEnabled })}
              >
                <div className={styles.numbers}>
                  <Field label="Messages" error={errors.spamMessages}>
                    <NumberInput value={r.spamMessages} onChange={(spamMessages) => patch({ spamMessages })} min={1} suffix="messages" />
                  </Field>
                  <Field label="Within" error={errors.spamSeconds}>
                    <NumberInput value={r.spamSeconds} onChange={(spamSeconds) => patch({ spamSeconds })} min={1} suffix="seconds" />
                  </Field>
                  <Field label="Identical messages" error={errors.spamDuplicates} help="At least 2.">
                    <NumberInput value={r.spamDuplicates} onChange={(spamDuplicates) => patch({ spamDuplicates })} min={2} suffix="times" />
                  </Field>
                </div>
                <p className={styles.hint} style={{ marginTop: 10 }}>
                  More than {plural(r.spamMessages, "message")} in {plural(r.spamSeconds, "second")}, or the same text{" "}
                  {r.spamDuplicates} times within a minute, counts as spam.
                </p>
              </RuleCard>

              <RuleCard
                title="Caps"
                footer={actions("caps")}
                description="Deletes messages that are mostly capital letters."
                enabled={r.capsEnabled}
                onToggle={(capsEnabled) => patch({ capsEnabled })}
              >
                <div className={styles.numbers}>
                  <Field label="Capitals" error={errors.capsPercent}>
                    <NumberInput value={r.capsPercent} onChange={(capsPercent) => patch({ capsPercent })} min={1} max={100} suffix="% or more" />
                  </Field>
                  <Field label="Only messages with at least" error={errors.capsMinLength}>
                    <NumberInput value={r.capsMinLength} onChange={(capsMinLength) => patch({ capsMinLength })} min={1} suffix="letters" />
                  </Field>
                </div>
              </RuleCard>

              <Section
                title="More filters"
                description="Scam and invite links run before the rules above, so they use their own action rather than the Links rule's."
              >
                {extras.draft ? (
                  <ExtraFilterCards form={extras} />
                ) : extras.loadError ? (
                  <Banner tone="error" title="Couldn't load the extra filters">
                    {extras.loadError}
                  </Banner>
                ) : null}
              </Section>

              <Card
                title="Escalation"
                description="With the plain delete action, every deleted message is a strike. Too many strikes in a short time mutes the member automatically."
              >
                <div className={styles.numbers}>
                  <Field label="Strikes" error={errors.strikeCount}>
                    <NumberInput value={r.strikeCount} onChange={(strikeCount) => patch({ strikeCount })} min={1} suffix="strikes" />
                  </Field>
                  <Field label="Within" error={errors.strikeWindowMinutes}>
                    <NumberInput
                      value={r.strikeWindowMinutes}
                      onChange={(strikeWindowMinutes) => patch({ strikeWindowMinutes })}
                      min={1}
                      suffix="minutes"
                    />
                  </Field>
                  <Field label="Mute for" error={errors.strikeMuteMinutes}>
                    <NumberInput
                      value={r.strikeMuteMinutes}
                      onChange={(strikeMuteMinutes) => patch({ strikeMuteMinutes })}
                      min={1}
                      suffix="minutes"
                    />
                  </Field>
                </div>
              </Card>

              <Card title="Ignored channels" description="Auto-mod doesn't check messages in these channels.">
                <ChannelMultiSelect
                  value={r.ignoredChannelIds}
                  onChange={(ignoredChannelIds) => patch({ ignoredChannelIds })}
                  emptyText="Every channel is checked"
                />
              </Card>

              <UnsavedBar
                dirty={form.dirty || extras.dirty}
                saving={saving || form.saving || extras.saving}
                invalid={invalid}
                onSave={() => void save()}
                onDiscard={() => {
                  form.discard();
                  extras.discard();
                }}
              />
            </>
          );
        }}
      </FormGate>
    </Stack>
  );
};

export default Automod;
