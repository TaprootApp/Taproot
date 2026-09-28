import React from "react";
import { configServiceClient } from "@taproot/gen-client";
import { Card, ChannelSelect, Field, PageHeader, Stack, TextInput } from "../../components";
import { useSession } from "../../lib";
import { FormGate, FormNotices, SaveBar, SelfRolePicker, firstError, useConfigForm } from "./shared";

// Prefix, mod log channel and self-assignable roles (!prefix, !modlog, !selfrole).

// Same rule as validPrefix in server/src/features/general.ts.
const PREFIX_RULE = "Pick 1 to 3 characters, no spaces or brackets.";
function prefixError(prefix: string): string | undefined {
  const p = prefix.trim();
  if (!p || p.length > 3 || /[\s[\]()]/.test(p)) return PREFIX_RULE;
  return undefined;
}

const General: React.FC = () => {
  const form = useConfigForm("general");
  const { refresh } = useSession();

  return (
    <Stack>
      <PageHeader title="General" description="The command prefix, where moderation actions are logged, and roles members can pick for themselves." />
      <FormGate form={form}>
        {(draft) => {
          const errors = { prefix: prefixError(draft.prefix) };
          const save = async () => {
            const ok = await form.save((d) => configServiceClient.updateGeneral({ ...d, prefix: d.prefix.trim() }));
            // The session carries the prefix shown elsewhere in the app.
            if (ok) void refresh();
          };
          return (
            <>
              <FormNotices form={form} />
              <Card title="Commands">
                <Field
                  label="Command prefix"
                  error={errors.prefix}
                  help={
                    <>
                      Members type this before every command, e.g. <span className="tp-mono">{draft.prefix.trim() || "!"}help</span>.
                    </>
                  }
                >
                  <TextInput
                    value={draft.prefix}
                    onChange={(prefix) => form.patch({ prefix })}
                    maxLength={3}
                    spellCheck={false}
                    autoComplete="off"
                    style={{ maxWidth: 120 }}
                  />
                </Field>
              </Card>

              <Card title="Mod log" description="Taproot posts every warning, mute, kick, ban and auto-mod action here.">
                <Field
                  label="Log channel"
                  help="Taproot posts a short hello when you pick a new channel; if it can't post there, the change isn't saved."
                >
                  <ChannelSelect
                    value={draft.modLogChannelId}
                    onChange={(modLogChannelId) => form.patch({ modLogChannelId })}
                    noneLabel="Off (don't log)"
                  />
                </Field>
              </Card>

              <Card
                title="Self-assignable roles"
                description={
                  <>
                    Members can give themselves these roles from the Me page or with{" "}
                    <span className="tp-mono">{draft.prefix.trim() || "!"}iam</span>.
                  </>
                }
              >
                <Field
                  label="Roles"
                  help="Roles with staff permissions (kick, ban, manage roles, full control…) are greyed out: letting members pick them would hand out moderator powers. Taproot can only give roles ranked below its own."
                >
                  <SelfRolePicker value={draft.selfRoleIds} onChange={(selfRoleIds) => form.patch({ selfRoleIds })} />
                </Field>
              </Card>

              <SaveBar form={form} onSave={() => void save()} invalid={firstError(errors)} />
            </>
          );
        }}
      </FormGate>
    </Stack>
  );
};

export default General;
