import React from "react";
import type { ChannelInfo, RoleInfo } from "@taproot/gen-shared";
import styles from "./Pickers.module.css";
import { Chip, Select, SelectOption } from "./Forms";
import { normalizeHex } from "./Badge";
import { useChannels, useRoles } from "../lib/lookups";

// Channel and role pickers backed by the shared lookups cache
// (sessionServiceClient.listChannels / listRoles, loaded once per app load).
// "None" is represented as undefined for single pickers.

const NONE = "\u0000none";

function channelOptions(channels: ChannelInfo[]): SelectOption<string>[] {
  return channels.map((c) => ({ value: c.id, label: `# ${c.name}`, group: c.groupName || undefined }));
}

function roleOptions(roles: RoleInfo[], excludePrivileged: boolean, taken: string[] = []): SelectOption<string>[] {
  return roles
    .filter((r) => !excludePrivileged || !r.privileged)
    .map((r) => ({
      value: r.id,
      label: r.privileged ? `${r.name} (staff)` : r.name,
      disabled: taken.includes(r.id),
    }));
}

export interface ChannelSelectProps {
  /** Selected channel ID, or undefined for none. */
  value: string | undefined;
  /** Called with the channel ID, or undefined when "none" is picked. */
  onChange: (channelId: string | undefined) => void;
  /** Adds a first option that clears the choice, e.g. "Off" or "No log channel". */
  noneLabel?: string;
  /** Default "Choose a channel". */
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}

/** Channel dropdown grouped by channel group. Moderator+ only (members can't list channels). */
export const ChannelSelect: React.FC<ChannelSelectProps> = ({
  value,
  onChange,
  noneLabel,
  placeholder = "Choose a channel",
  disabled,
  id,
}) => {
  const channels = useChannels();
  const options = channelOptions(channels.items);
  if (value && !channels.byId.has(value) && !channels.loading) {
    options.unshift({ value, label: "Unknown channel (deleted or hidden)" });
  }
  if (noneLabel) options.unshift({ value: NONE, label: noneLabel });
  return (
    <PickerShell error={channels.error} onRetry={channels.reload}>
      <Select
        id={id}
        value={value ?? (noneLabel ? NONE : undefined)}
        onChange={(v) => onChange(v === NONE ? undefined : v)}
        options={options}
        placeholder={channels.loading ? "Loading channels…" : placeholder}
        disabled={disabled || (channels.loading && channels.items.length === 0)}
      />
    </PickerShell>
  );
};

export interface RoleSelectProps {
  /** Selected role ID, or undefined for none. */
  value: string | undefined;
  /** Called with the role ID, or undefined when "none" is picked. */
  onChange: (roleId: string | undefined) => void;
  /** Adds a first option that clears the choice. */
  noneLabel?: string;
  /** Hide roles with staff permissions (reaction panels, self roles). */
  excludePrivileged?: boolean;
  /** Default "Choose a role". */
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}

/** Role dropdown. */
export const RoleSelect: React.FC<RoleSelectProps> = ({
  value,
  onChange,
  noneLabel,
  excludePrivileged = false,
  placeholder = "Choose a role",
  disabled,
  id,
}) => {
  const roles = useRoles();
  const options = roleOptions(roles.items, excludePrivileged);
  if (value && !options.some((o) => o.value === value) && !roles.loading) {
    const known = roles.byId.get(value);
    options.unshift({ value, label: known ? known.name : "Unknown role (deleted)" });
  }
  if (noneLabel) options.unshift({ value: NONE, label: noneLabel });
  return (
    <PickerShell error={roles.error} onRetry={roles.reload}>
      <Select
        id={id}
        value={value ?? (noneLabel ? NONE : undefined)}
        onChange={(v) => onChange(v === NONE ? undefined : v)}
        options={options}
        placeholder={roles.loading ? "Loading roles…" : placeholder}
        disabled={disabled || (roles.loading && roles.items.length === 0)}
      />
    </PickerShell>
  );
};

export interface MultiPickerProps {
  /** Selected IDs, in order. */
  value: string[];
  /** Called with the new list. */
  onChange: (ids: string[]) => void;
  /** Text of the "add" dropdown. */
  placeholder?: string;
  /** Shown when nothing is selected, e.g. "No roles". */
  emptyText?: string;
  disabled?: boolean;
  id?: string;
}

/** Several roles as removable chips plus an "Add role" dropdown. excludePrivileged hides staff roles from the dropdown. */
export const RoleMultiSelect: React.FC<MultiPickerProps & { excludePrivileged?: boolean }> = ({
  value,
  onChange,
  excludePrivileged = false,
  placeholder = "Add a role…",
  emptyText = "No roles selected",
  disabled,
  id,
}) => {
  const roles = useRoles();
  return (
    <PickerShell error={roles.error} onRetry={roles.reload}>
      <div className={styles.multi}>
        <div className={styles.chips}>
          {value.length === 0 && <span className={styles.empty}>{emptyText}</span>}
          {value.map((roleId) => {
            const role = roles.byId.get(roleId);
            return (
              <Chip
                key={roleId}
                label={role ? role.name : roles.loading ? "…" : "Unknown role"}
                muted={!role}
                color={role?.colorHex ? normalizeHex(role.colorHex) : undefined}
                onRemove={disabled ? undefined : () => onChange(value.filter((v) => v !== roleId))}
              />
            );
          })}
        </div>
        <Select
          id={id}
          value={undefined}
          onChange={(roleId) => onChange([...value, roleId])}
          options={roleOptions(roles.items, excludePrivileged, value)}
          placeholder={roles.loading ? "Loading roles…" : placeholder}
          disabled={disabled || roles.loading}
          className={styles.adder}
        />
      </div>
    </PickerShell>
  );
};

/** Several channels as removable chips plus an "Add channel" dropdown. */
export const ChannelMultiSelect: React.FC<MultiPickerProps> = ({
  value,
  onChange,
  placeholder = "Add a channel…",
  emptyText = "No channels selected",
  disabled,
  id,
}) => {
  const channels = useChannels();
  const options = channelOptions(channels.items).map((o) => ({ ...o, disabled: value.includes(o.value) }));
  return (
    <PickerShell error={channels.error} onRetry={channels.reload}>
      <div className={styles.multi}>
        <div className={styles.chips}>
          {value.length === 0 && <span className={styles.empty}>{emptyText}</span>}
          {value.map((channelId) => {
            const channel = channels.byId.get(channelId);
            return (
              <Chip
                key={channelId}
                label={channel ? `# ${channel.name}` : channels.loading ? "…" : "Unknown channel"}
                muted={!channel}
                onRemove={disabled ? undefined : () => onChange(value.filter((v) => v !== channelId))}
              />
            );
          })}
        </div>
        <Select
          id={id}
          value={undefined}
          onChange={(channelId) => onChange([...value, channelId])}
          options={options}
          placeholder={channels.loading ? "Loading channels…" : placeholder}
          disabled={disabled || channels.loading}
          className={styles.adder}
        />
      </div>
    </PickerShell>
  );
};

/** Shows a small retry line under a picker whose list failed to load. */
const PickerShell: React.FC<{ error: string | undefined; onRetry: () => void; children: React.ReactNode }> = ({
  error,
  onRetry,
  children,
}) => (
  <>
    {children}
    {error && (
      <p className={styles.error}>
        {error}{" "}
        <button type="button" className="tp-link" onClick={onRetry}>
          Retry
        </button>
      </p>
    )}
  </>
);
