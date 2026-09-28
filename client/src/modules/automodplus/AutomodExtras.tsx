import React, { useState } from "react";
import { AutomodplusAction } from "@taproot/gen-shared";
import type { AutomodplusAutomodConfig, AutomodplusFilters, AutomodplusRuleSettings } from "@taproot/gen-shared";
import { automodplusServiceClient } from "@taproot/gen-client";
import {
  Badge,
  Card,
  ChannelMultiSelect,
  ChannelSelect,
  Field,
  NumberInput,
  RoleMultiSelect,
  Select,
  Stack,
  TextArea,
  Toggle,
} from "../../components";
import { useChannels } from "../../lib";
import { TagList } from "../../views/settings/shared";
import { DraftForm, firstError, rangeError, useDraftForm } from "./shared";
import styles from "./automodplus.module.css";

// The extra Auto-mod options (the automodplus module), embedded in the
// existing Auto-mod page (views/settings/Automod.tsx): a per-rule action
// block for every rule, and cards for the extra filters. Limits mirror
// LIMITS in server/src/modules/automodplus/config.ts.

export type ExtrasForm = DraftForm<AutomodplusAutomodConfig>;

export function useAutomodExtras(): ExtrasForm {
  return useDraftForm(() => automodplusServiceClient.getAutomodExtras(), "automodplus:automod");
}

export function saveExtras(form: ExtrasForm): Promise<boolean> {
  return form.save((d) => automodplusServiceClient.updateAutomodExtras(d));
}

const ACTION_OPTIONS = [
  { value: AutomodplusAction.DELETE, label: "Delete it (counts a strike)" },
  { value: AutomodplusAction.WARN, label: "Delete and warn" },
  { value: AutomodplusAction.MUTE, label: "Delete and mute" },
  { value: AutomodplusAction.KICK, label: "Delete and kick" },
  { value: AutomodplusAction.BAN, label: "Delete and ban" },
];

export function extrasErrors(d: AutomodplusAutomodConfig | undefined): Record<string, string | undefined> {
  if (!d?.filters) return {};
  const f = d.filters;
  const errors: Record<string, string | undefined> = {
    emojiMax: rangeError(f.emojiMax, 1, 200, "Max emoji"),
    wallMaxLines: rangeError(f.wallMaxLines, 2, 200, "Max lines"),
    wallMaxChars: rangeError(f.wallMaxChars, 100, 9500, "Max characters"),
    repeatedMax: rangeError(f.repeatedMax, 3, 500, "Repeated characters"),
    attachmentsMax: rangeError(f.attachmentsMax, 1, 50, "Max attachments"),
    newMemberMinutes: rangeError(f.newMemberMinutes, 1, 10080, "New member minutes"),
  };
  for (const r of d.rules) {
    if (r.action === AutomodplusAction.MUTE) errors[`mute:${r.rule}`] = rangeError(r.muteMinutes, 1, 40320, "Mute minutes");
    if (r.response.length > 500) errors[`response:${r.rule}`] = "Responses can be at most 500 characters.";
  }
  return errors;
}

export { firstError };

function patchRule(form: ExtrasForm, rule: string, change: Partial<AutomodplusRuleSettings>): void {
  form.set((d) => ({ ...d, rules: d.rules.map((r) => (r.rule === rule ? { ...r, ...change } : r)) }));
}

function patchFilters(form: ExtrasForm, change: Partial<AutomodplusFilters>): void {
  form.set((d) => ({ ...d, filters: { ...d.filters!, ...change } }));
}

/** "When this rule removes a message" block for the bottom of a rule card. */
export const RuleActions: React.FC<{ form: ExtrasForm; rule: string }> = ({ form, rule }) => {
  const channels = useChannels();
  const settings = form.draft?.rules.find((r) => r.rule === rule);
  const [open, setOpen] = useState(false);
  if (!settings) return null;
  const change = (c: Partial<AutomodplusRuleSettings>) => patchRule(form, rule, c);
  const exemptions = settings.exemptChannelIds.length + settings.exemptRoleIds.length;
  const logName = settings.logChannelId ? channels.byId.get(settings.logChannelId)?.name : undefined;

  return (
    <div className={styles.actions}>
      <div className={styles.actionRow}>
        <Field label="When this rule removes a message">
          <Select
            value={settings.action}
            onChange={(action: AutomodplusAction) => change({ action })}
            options={ACTION_OPTIONS}
            className={styles.actionSelect}
          />
        </Field>
        {settings.action === AutomodplusAction.MUTE && (
          <Field label="Mute for" error={rangeError(settings.muteMinutes, 1, 40320, "Mute minutes")}>
            <NumberInput value={settings.muteMinutes} onChange={(muteMinutes) => change({ muteMinutes })} min={1} suffix="minutes" />
          </Field>
        )}
        <button type="button" className="tp-link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Fewer options" : "Notice, log and exemptions"}
        </button>
      </div>
      {!open && (settings.response || settings.logChannelId || exemptions > 0) && (
        <div className={styles.summary}>
          {settings.response && <Badge tone="info">Custom notice</Badge>}
          {settings.logChannelId && <Badge tone="info">Logs to #{logName ?? "channel"}</Badge>}
          {exemptions > 0 && <Badge tone="neutral">{exemptions} exemption{exemptions === 1 ? "" : "s"}</Badge>}
        </div>
      )}
      {open && (
        <div className={styles.more}>
          <div className={styles.moreWide}>
            <Field
              label="Notice"
              help="Shown briefly in the channel instead of the default. {user} {user.name} {rule} {channel} are filled in."
              error={settings.response.length > 500 ? "At most 500 characters." : undefined}
            >
              <TextArea
                value={settings.response}
                onChange={(response) => change({ response })}
                placeholder="Default notice"
                maxLength={500}
                showCount
                autoGrow
              />
            </Field>
          </div>
          <Field label="Also report in" help="A short report with the removed text. The mod log gets its case either way.">
            <ChannelSelect
              value={settings.logChannelId}
              onChange={(logChannelId) => change({ logChannelId })}
              noneLabel="No extra report"
            />
          </Field>
          <Field label="Not in these channels">
            <ChannelMultiSelect
              value={settings.exemptChannelIds}
              onChange={(exemptChannelIds) => change({ exemptChannelIds })}
              emptyText="Every channel"
            />
          </Field>
          <Field label="Not for these roles">
            <RoleMultiSelect value={settings.exemptRoleIds} onChange={(exemptRoleIds) => change({ exemptRoleIds })} emptyText="Every role" />
          </Field>
        </div>
      )}
    </div>
  );
};

const FilterCard: React.FC<{
  title: string;
  description: React.ReactNode;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  form: ExtrasForm;
  rule: string;
  children?: React.ReactNode;
}> = ({ title, description, enabled, onToggle, form, rule, children }) => (
  <Card title={title} description={description} actions={<Toggle checked={enabled} onChange={onToggle} ariaLabel={`${title} on/off`} />}>
    <div className={enabled ? undefined : styles.dimmed}>
      {children}
      <RuleActions form={form} rule={rule} />
    </div>
  </Card>
);

/** Same rules as updateAutomodExtras on the server. */
function parseDomains(text: string): string[] | string {
  const out: string[] = [];
  for (const input of text.split(/[\s,]+/).filter(Boolean)) {
    const domain = input.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    if (!domain.includes(".")) return `"${input}" isn't a domain.`;
    out.push(domain);
  }
  return out;
}

function parseCodes(text: string): string[] | string {
  const out: string[] = [];
  for (const input of text.split(/[\s,]+/).filter(Boolean)) {
    const code = input.replace(/\/+$/, "").replace(/^.*\//, "");
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(code)) return `"${input}" isn't an invite code.`;
    out.push(code);
  }
  return out;
}

/** Cards for the extra filters, in the order they run. */
export const ExtraFilterCards: React.FC<{ form: ExtrasForm }> = ({ form }) => {
  const f = form.draft?.filters;
  if (!f) return null;
  const errors = extrasErrors(form.draft);
  const patch = (c: Partial<AutomodplusFilters>) => patchFilters(form, c);

  return (
    <Stack>
      <FilterCard
        title="Scam links"
        description="Deletes phishing: lookalike domains (dlscord, steamcommunlty…), known scam phrases, and gift or prize bait with a link."
        enabled={f.scamEnabled}
        onToggle={(scamEnabled) => patch({ scamEnabled })}
        form={form}
        rule="scam"
      >
        <Field label="Also block these domains" help="Subdomains are included. The built-in list needs no setup.">
          <TagList
            value={f.scamDomains}
            onChange={(scamDomains) => patch({ scamDomains })}
            parse={parseDomains}
            placeholder="e.g. free-gifts.example"
            emptyText="Only the built-in list"
            mono
          />
        </Field>
      </FilterCard>

      <FilterCard
        title="Invite links"
        description="Deletes invites to other Root communities."
        enabled={f.invitesEnabled}
        onToggle={(invitesEnabled) => patch({ invitesEnabled })}
        form={form}
        rule="invites"
      >
        <Field label="Allowed invite codes" help="Your own community's codes, e.g. the part after /invite/.">
          <TagList
            value={f.allowedInviteCodes}
            onChange={(allowedInviteCodes) => patch({ allowedInviteCodes })}
            parse={parseCodes}
            placeholder="e.g. AbC123 or a full invite link"
            emptyText="No invites allowed"
            mono
          />
        </Field>
      </FilterCard>

      <FilterCard
        title="New member links"
        description="Members who joined recently can't post links."
        enabled={f.newMemberLinksEnabled}
        onToggle={(newMemberLinksEnabled) => patch({ newMemberLinksEnabled })}
        form={form}
        rule="newMemberLinks"
      >
        <Field label="For the first" error={errors.newMemberMinutes}>
          <NumberInput value={f.newMemberMinutes} onChange={(newMemberMinutes) => patch({ newMemberMinutes })} min={1} suffix="minutes" />
        </Field>
      </FilterCard>

      <FilterCard
        title="Attachment spam"
        description="Deletes messages with too many files at once."
        enabled={f.attachmentsEnabled}
        onToggle={(attachmentsEnabled) => patch({ attachmentsEnabled })}
        form={form}
        rule="attachments"
      >
        <Field label="Most attachments allowed" error={errors.attachmentsMax}>
          <NumberInput value={f.attachmentsMax} onChange={(attachmentsMax) => patch({ attachmentsMax })} min={1} suffix="files" />
        </Field>
      </FilterCard>

      <FilterCard
        title="Emoji spam"
        description="Deletes messages with too many emoji."
        enabled={f.emojiEnabled}
        onToggle={(emojiEnabled) => patch({ emojiEnabled })}
        form={form}
        rule="emoji"
      >
        <Field label="Most emoji allowed" error={errors.emojiMax}>
          <NumberInput value={f.emojiMax} onChange={(emojiMax) => patch({ emojiMax })} min={1} suffix="emoji" />
        </Field>
      </FilterCard>

      <FilterCard
        title="Zalgo text"
        description="Deletes glitchy text stacked with combining marks. Normal accents are fine."
        enabled={f.zalgoEnabled}
        onToggle={(zalgoEnabled) => patch({ zalgoEnabled })}
        form={form}
        rule="zalgo"
      />

      <FilterCard
        title="Repeated characters"
        description={'Deletes messages like "heyyyyyyyyyyyyyyyy" or "!!!!!!!!!!!!!!!!".'}
        enabled={f.repeatedEnabled}
        onToggle={(repeatedEnabled) => patch({ repeatedEnabled })}
        form={form}
        rule="repeated"
      >
        <Field label="Most repeats in a row" error={errors.repeatedMax}>
          <NumberInput value={f.repeatedMax} onChange={(repeatedMax) => patch({ repeatedMax })} min={3} suffix="characters" />
        </Field>
      </FilterCard>

      <FilterCard
        title="Wall of text"
        description="Deletes very long messages."
        enabled={f.wallEnabled}
        onToggle={(wallEnabled) => patch({ wallEnabled })}
        form={form}
        rule="newlines"
      >
        <div className={styles.numbers}>
          <Field label="Most lines" error={errors.wallMaxLines}>
            <NumberInput value={f.wallMaxLines} onChange={(wallMaxLines) => patch({ wallMaxLines })} min={2} suffix="lines" />
          </Field>
          <Field label="Most characters" error={errors.wallMaxChars}>
            <NumberInput value={f.wallMaxChars} onChange={(wallMaxChars) => patch({ wallMaxChars })} min={100} suffix="characters" />
          </Field>
        </div>
      </FilterCard>
    </Stack>
  );
};
