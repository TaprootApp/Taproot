import React, { useEffect, useRef, useState } from "react";
import { configServiceClient } from "@taproot/gen-client";
import styles from "./Settings.module.css";
import {
  Card,
  ChannelSelect,
  Field,
  MessagePreview,
  PageHeader,
  RoleMultiSelect,
  Spinner,
  Stack,
  TextArea,
  Toggle,
} from "../../components";
import { useRpc } from "../../lib";
import { FormGate, FormNotices, SaveBar, firstError, useConfigForm } from "./shared";

// Welcome/goodbye messages and autoroles (!welcome, !goodbye, !autorole).
// A message is "off" when it has no channel; the text is kept either way.

// MAX_MESSAGE in server/src/lib/text.ts.
const MAX_MESSAGE = 9500;

function messageError(text: string, name: string): string | undefined {
  if (!text.trim()) return `${name} can't be empty.`;
  if (text.length > MAX_MESSAGE) return `${name} is too long (${MAX_MESSAGE} characters max).`;
  return undefined;
}

const PlaceholderHelp: React.FC = () => (
  <p className={styles.hint}>
    Placeholders: <code>{"{user}"}</code> mentions the member, <code>{"{user.name}"}</code> is their name,{" "}
    <code>{"{server}"}</code> is the community name. Markdown like <code>**bold**</code> works too.
  </p>
);

/** Server-rendered preview of a template for the current admin, refreshed as they type. */
const TemplatePreview: React.FC<{ template: string }> = ({ template }) => {
  const [debounced, setDebounced] = useState(template);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(template), 400);
    return () => clearTimeout(t);
  }, [template]);
  const skip = !debounced.trim() || debounced.length > MAX_MESSAGE;
  const preview = useRpc(() => configServiceClient.previewTemplate({ template: debounced }), [debounced], { skip });
  return (
    <Stack gap={6}>
      <span className={styles.previewLabel}>
        Preview (as you) {preview.loading && <Spinner size={12} inline />}
      </span>
      {preview.error && !skip ? (
        <p className={styles.error}>{preview.error}</p>
      ) : (
        <MessagePreview
          content={skip ? "" : (preview.data?.content ?? "")}
          author="Taproot"
          emptyText={skip ? "Write a message to see it here" : "Rendering…"}
        />
      )}
    </Stack>
  );
};

interface MessageCardProps {
  title: string;
  description: string;
  channelId: string | undefined;
  message: string;
  onChannel: (id: string | undefined) => void;
  onMessage: (text: string) => void;
  /** Bumped when the form is reset, so the local "on but no channel yet" state clears. */
  resetKey: unknown;
  name: string;
  onError: (error: string | undefined) => void;
}

const MessageCard: React.FC<MessageCardProps> = ({
  title,
  description,
  channelId,
  message,
  onChannel,
  onMessage,
  resetKey,
  name,
  onError,
}) => {
  // Switched on but no channel picked yet; remembers the last channel so
  // toggling off and on again restores it.
  const [pendingOn, setPendingOn] = useState(false);
  const lastChannel = useRef(channelId);
  if (channelId) lastChannel.current = channelId;
  useEffect(() => setPendingOn(false), [resetKey]);

  const on = !!channelId || pendingOn;
  const channelError = on && !channelId ? "Pick a channel, or switch this off." : undefined;
  const textError = messageError(message, `The ${name} message`);
  const error = channelError ?? textError;
  useEffect(() => onError(error), [error, onError]);

  return (
    <Card
      title={title}
      description={description}
      actions={
        <Toggle
          checked={on}
          ariaLabel={`${title} on/off`}
          onChange={(next) => {
            if (next) {
              if (lastChannel.current) onChannel(lastChannel.current);
              else setPendingOn(true);
            } else {
              setPendingOn(false);
              onChannel(undefined);
            }
          }}
        />
      }
    >
      <Stack>
        <div className={on ? undefined : styles.dimmed}>
          <Field label="Channel" error={channelError}>
            <ChannelSelect value={channelId} onChange={onChannel} placeholder="Choose a channel" disabled={!on} />
          </Field>
        </div>
        <Field label="Message" error={textError}>
          <TextArea value={message} onChange={onMessage} maxLength={MAX_MESSAGE} rows={3} />
        </Field>
        <PlaceholderHelp />
        <TemplatePreview template={message} />
      </Stack>
    </Card>
  );
};

const Welcome: React.FC = () => {
  const form = useConfigForm("welcome");
  const [cardErrors, setCardErrors] = useState<{ welcome?: string; goodbye?: string }>({});
  const onWelcomeError = React.useCallback((welcome: string | undefined) => setCardErrors((e) => ({ ...e, welcome })), []);
  const onGoodbyeError = React.useCallback((goodbye: string | undefined) => setCardErrors((e) => ({ ...e, goodbye })), []);

  return (
    <Stack>
      <PageHeader title="Welcome" description="Greet new members, say goodbye when they leave, and give roles on join." />
      <FormGate form={form}>
        {(draft) => {
          const resetKey = form.version;
          return (
            <>
              <FormNotices form={form} />
              <MessageCard
                title="Welcome message"
                description="Posted when someone joins the community."
                name="welcome"
                channelId={draft.welcomeChannelId}
                message={draft.welcomeMessage}
                onChannel={(welcomeChannelId) => form.patch({ welcomeChannelId })}
                onMessage={(welcomeMessage) => form.patch({ welcomeMessage })}
                resetKey={resetKey}
                onError={onWelcomeError}
              />
              <MessageCard
                title="Goodbye message"
                description="Posted when someone leaves. Mentions won't reach them, so {user.name} usually reads better here."
                name="goodbye"
                channelId={draft.goodbyeChannelId}
                message={draft.goodbyeMessage}
                onChannel={(goodbyeChannelId) => form.patch({ goodbyeChannelId })}
                onMessage={(goodbyeMessage) => form.patch({ goodbyeMessage })}
                resetKey={resetKey}
                onError={onGoodbyeError}
              />
              <Card title="Autoroles" description="Given to every member as soon as they join.">
                <Field
                  label="Roles"
                  help="Taproot can only give roles ranked below its own. Be careful with roles that carry staff permissions."
                >
                  <RoleMultiSelect
                    value={draft.autoroleIds}
                    onChange={(autoroleIds) => form.patch({ autoroleIds })}
                    emptyText="No autoroles"
                  />
                </Field>
              </Card>
              <SaveBar
                form={form}
                onSave={() => void form.save((d) => configServiceClient.updateWelcome(d))}
                invalid={firstError(cardErrors)}
              />
            </>
          );
        }}
      </FormGate>
    </Stack>
  );
};

export default Welcome;
