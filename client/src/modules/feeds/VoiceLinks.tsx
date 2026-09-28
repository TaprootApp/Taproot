import React, { useState } from "react";
import type { FeedsVoiceLink } from "@taproot/gen-shared";
import { feedsServiceClient } from "@taproot/gen-client";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  PageHeader,
  Stack,
  Table,
} from "../../components";
import type { Column } from "../../components";
import { plural, useAction, useRpc } from "../../lib";
import { FeedChannelSelect, useFeedChannels, useFeedsChanged } from "./shared";
import styles from "./feeds.module.css";

// Voice links (admin): members in a voice channel can see and post in a
// linked text channel while they're in voice. Same rules as "voicelink".

const VoiceLinks: React.FC = () => {
  const list = useRpc(() => feedsServiceClient.listVoiceLinks());
  const channels = useFeedChannels();
  useFeedsChanged(["feeds:voice"], () => void list.reload());

  const [voiceId, setVoiceId] = useState<string | undefined>(undefined);
  const [textId, setTextId] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState<FeedsVoiceLink | undefined>(undefined);

  const add = useAction(
    () => feedsServiceClient.addVoiceLink({ voiceChannelId: voiceId ?? "", textChannelId: textId ?? "" }),
    { success: "Linked. Members in voice now have access." },
  );
  const remove = useAction((voiceChannelId: string) => feedsServiceClient.removeVoiceLink({ voiceChannelId, textChannelId: "" }), {
    success: "Link removed.",
  });

  const links = list.data?.links ?? [];
  const relink = !!voiceId && links.some((l) => l.voiceChannelId === voiceId);

  const columns: Column<FeedsVoiceLink>[] = [
    { key: "voice", header: "Voice channel", render: (l) => `🔊 ${l.voiceChannelName}` },
    { key: "text", header: "Text channel", render: (l) => `#${l.textChannelName}` },
    {
      key: "members",
      header: "In voice",
      align: "right",
      width: "90px",
      render: (l) => <span className="tp-subtle">{l.activeMembers}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "56px",
      render: (l) => (
        <div className={styles.cellActions}>
          <IconButton icon="trash" label={`Unlink ${l.voiceChannelName}`} danger onClick={() => setRemoving(l)} />
        </div>
      ),
    },
  ];

  const channelPicker = (voice: boolean, value: string | undefined, onChange: (id: string) => void) => (
    <FeedChannelSelect
      channels={channels.data?.channels}
      loading={channels.loading}
      error={channels.error}
      onRetry={() => void channels.reload()}
      voice={voice}
      value={value}
      onChange={onChange}
    />
  );

  return (
    <>
      <PageHeader
        title="Voice links"
        description="Members in a voice channel can see and post in its linked text channel while they're in voice."
      />
      <Stack gap={16}>
        <Card
          title="New link"
          description="Make the text channel private first, so only people in voice (and staff) can see it."
          footer={
            <Button
              variant="primary"
              icon="link"
              loading={add.busy}
              disabled={!voiceId || !textId}
              onClick={async () => {
                const result = await add.run();
                if (result) {
                  list.setData(result);
                  setVoiceId(undefined);
                  setTextId(undefined);
                }
              }}
            >
              {relink ? "Change link" : "Link"}
            </Button>
          }
        >
          <Stack gap={16}>
            <Field label="Voice channel">{channelPicker(true, voiceId, setVoiceId)}</Field>
            <Field label="Text channel">{channelPicker(false, textId, setTextId)}</Field>
            {relink && <Banner tone="info">That voice channel is already linked; this replaces its text channel.</Banner>}
          </Stack>
        </Card>

        {list.error && !list.data ? (
          <Card>
            <ErrorState message={list.error} onRetry={() => void list.reload()} />
          </Card>
        ) : (
          <Card padded={false} title="Links" description={list.data ? plural(links.length, "link") : undefined}>
            <Table
              columns={columns}
              rows={links}
              rowKey={(l) => l.voiceChannelId}
              loading={list.loading}
              empty={
                <EmptyState
                  icon={<Icon name="volume" size={28} />}
                  title="No voice links yet"
                  description="Link a voice channel to a text channel above."
                  compact
                />
              }
            />
          </Card>
        )}
        <p className="tp-subtle">
          A muted member can see the channel but still can't post. Anyone an admin has hidden the channel from stays hidden.
        </p>
      </Stack>

      <ConfirmDialog
        open={!!removing}
        title="Remove link?"
        message={removing && <>Members in 🔊 {removing.voiceChannelName} lose access to #{removing.textChannelName} right away.</>}
        confirmLabel="Remove"
        danger
        busy={remove.busy}
        onCancel={() => setRemoving(undefined)}
        onConfirm={async () => {
          if (!removing) return;
          const result = await remove.run(removing.voiceChannelId);
          if (result) list.setData(result);
          setRemoving(undefined);
        }}
      />
    </>
  );
};

export default VoiceLinks;
