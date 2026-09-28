import React, { useMemo, useState } from "react";
import type { Announcement, AnnouncementList } from "@taproot/gen-shared";
import { Repeat } from "@taproot/gen-shared";
import { contentServiceClient } from "@taproot/gen-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  ChannelSelect,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  MessagePreview,
  PageHeader,
  Select,
  Stack,
  Table,
  TextArea,
  TextInput,
} from "../components";
import type { Column } from "../components";
import {
  formatDateTime,
  formatRelative,
  fromLocalInput,
  plural,
  postMessage,
  REPEAT_LABEL,
  toLocalInput,
  truncate,
  useAction,
  useChannels,
  useRpc,
} from "../lib";
import { channelLabel, MAX_MESSAGE, useContentChanged } from "./content/shared";
import styles from "./content/content.module.css";

// Announcements (moderator+): post a message as Taproot now, or schedule
// one (optionally repeating). Same jobs as "announce" / "schedule" in chat.

const REPEAT_OPTIONS = [Repeat.ONCE, Repeat.DAILY, Repeat.WEEKLY, Repeat.MONTHLY].map((r) => ({
  value: r,
  label: REPEAT_LABEL[r],
}));

const TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
})();

/** Next round hour at least 30 minutes away, as a starting suggestion. */
function suggestedTime(): number {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime();
}

const Announcements: React.FC = () => {
  const list = useRpc(() => contentServiceClient.listAnnouncements());
  useContentChanged(["announcements"], () => void list.reload());
  const [deleting, setDeleting] = useState<Announcement | undefined>(undefined);

  const remove = useAction((id: number) => contentServiceClient.deleteAnnouncement({ id }), {
    success: "Announcement deleted.",
  });

  const announcements = useMemo(
    () => [...(list.data?.announcements ?? [])].sort((a, b) => a.nextAtMs - b.nextAtMs),
    [list.data],
  );

  const columns: Column<Announcement>[] = [
    {
      key: "next",
      header: "Next post",
      width: "30%",
      render: (a) => (
        <div>
          <div>{formatDateTime(a.nextAtMs)}</div>
          <div className="tp-subtle">{formatRelative(a.nextAtMs)}</div>
        </div>
      ),
    },
    { key: "channel", header: "Channel", width: "18%", render: (a) => channelLabel(a.channelName) },
    {
      key: "message",
      header: "Message",
      hideOnMobile: true,
      render: (a) => (
        <span className={styles.clip} title={a.message}>
          {truncate(a.message.replace(/\s+/g, " "), 100)}
        </span>
      ),
    },
    {
      key: "repeat",
      header: "Repeats",
      width: "96px",
      render: (a) => <Badge tone={a.repeat === Repeat.ONCE ? "neutral" : "brand"}>{REPEAT_LABEL[a.repeat]}</Badge>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "52px",
      render: (a) => (
        <div className={styles.cellActions}>
          <IconButton icon="trash" label={`Delete announcement #${a.id}`} danger onClick={() => setDeleting(a)} />
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Announcements"
        description="Post a message as Taproot, now or on a schedule."
      />
      <Stack gap={16}>
        <PostNow />
        <Scheduler onCreated={(result) => list.setData(result)} />
        <Card
          title="Scheduled"
          description={
            announcements.length
              ? `${plural(announcements.length, "announcement")} waiting. Times are shown in your local time.`
              : undefined
          }
          padded={false}
        >
          {list.error && !list.data ? (
            <ErrorState message={list.error} onRetry={() => void list.reload()} />
          ) : (
            <Table
              columns={columns}
              rows={announcements}
              rowKey={(a) => a.id}
              loading={list.loading}
              empty={
                <EmptyState
                  compact
                  icon={<Icon name="clock" size={28} />}
                  title="Nothing scheduled"
                  description="Scheduled announcements show up here until they've posted for the last time."
                />
              }
            />
          )}
        </Card>
      </Stack>

      <ConfirmDialog
        open={!!deleting}
        title="Delete announcement?"
        message={
          deleting && (
            <>
              It won't post in {channelLabel(deleting.channelName)}
              {deleting.repeat === Repeat.ONCE ? "" : " again"}. This can't be undone.
            </>
          )
        }
        confirmLabel="Delete"
        danger
        busy={remove.busy}
        onCancel={() => setDeleting(undefined)}
        onConfirm={async () => {
          if (!deleting) return;
          const result = await remove.run(deleting.id);
          if (result) list.setData(result);
          setDeleting(undefined);
        }}
      >
        {deleting && <MessagePreview content={deleting.message} author="Taproot" />}
      </ConfirmDialog>
    </>
  );
};

const PostNow: React.FC = () => {
  const channels = useChannels();
  const [channelId, setChannelId] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState("");
  const channelName = channelId ? channels.byId.get(channelId)?.name : undefined;

  // lib's postMessage waits for the server, so a failure (no permission to
  // post, deleted channel) shows as an error toast instead of a false success.
  const post = useAction(
    async (channel: string, text: string) => {
      await postMessage({ channelId: channel, message: text });
      return true;
    },
    { success: `Sent to ${channelLabel(channelName)}.` },
  );

  const canPost = !!channelId && !!message.trim() && !post.busy;
  const submit = async () => {
    if (!channelId || !canPost) return;
    if (await post.run(channelId, message)) setMessage("");
  };

  return (
    <Card
      title="Post now"
      description="Taproot posts the message right away, like the announce command."
      footer={
        <Button variant="primary" icon="send" onClick={submit} loading={post.busy} disabled={!canPost}>
          Post
        </Button>
      }
    >
      <Stack gap={16}>
        <Field label="Channel">
          <ChannelSelect value={channelId} onChange={setChannelId} placeholder="Pick a channel" />
        </Field>
        <Field label="Message" help="Markdown works.">
          <TextArea value={message} onChange={setMessage} maxLength={MAX_MESSAGE} rows={3} placeholder="Server maintenance tonight at 9." />
        </Field>
        {message.trim() && (
          <div>
            <div className={styles.previewLabel}>Preview</div>
            <MessagePreview content={message} author="Taproot" />
          </div>
        )}
      </Stack>
    </Card>
  );
};

const Scheduler: React.FC<{ onCreated: (list: AnnouncementList) => void }> = ({ onCreated }) => {
  const [channelId, setChannelId] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState("");
  const [initial] = useState(() => toLocalInput(suggestedTime()));
  const [date, setDate] = useState(initial.slice(0, 10));
  const [time, setTime] = useState(initial.slice(11, 16));
  const [repeat, setRepeat] = useState<Repeat>(Repeat.ONCE);
  const [touched, setTouched] = useState(false);

  const atMs = date && time ? fromLocalInput(`${date}T${time}`) : undefined;
  // "Once" must be at least a minute out (the server's rule); repeats roll a
  // past time forward to the next occurrence.
  const timeError =
    atMs === undefined
      ? touched
        ? "Pick a date and time."
        : undefined
      : repeat === Repeat.ONCE && atMs < Date.now() + 60_000
        ? "Pick a time at least a minute from now."
        : undefined;

  const create = useAction(
    () =>
      contentServiceClient.createAnnouncement({
        channelId: channelId ?? "",
        message,
        atMs: atMs ?? 0,
        repeat,
      }),
    { success: "Announcement scheduled." },
  );

  const canCreate = !!channelId && !!message.trim() && atMs !== undefined && !timeError && !create.busy;
  const submit = async () => {
    setTouched(true);
    if (!canCreate) return;
    const result = await create.run();
    if (result) {
      onCreated(result);
      setMessage("");
      setTouched(false);
    }
  };

  const when =
    atMs !== undefined && !timeError
      ? repeat === Repeat.ONCE
        ? `Posts ${formatDateTime(atMs)} (${formatRelative(atMs)}).`
        : `Posts ${REPEAT_LABEL[repeat].toLowerCase()}, starting ${formatDateTime(atMs)}${
            atMs < Date.now() ? " (or the next time that comes around)" : ""
          }.`
      : undefined;

  return (
    <Card
      title="Schedule"
      description="Post later, or on repeat. Posts go out within about a minute of the time you pick."
      footer={
        <Button variant="primary" icon="clock" onClick={submit} loading={create.busy} disabled={touched && !canCreate}>
          Schedule
        </Button>
      }
    >
      <Stack gap={16}>
        <Field label="Channel" error={touched && !channelId ? "Pick a channel." : undefined}>
          <ChannelSelect value={channelId} onChange={setChannelId} placeholder="Pick a channel" />
        </Field>
        <Field label="Message" error={touched && !message.trim() ? "Write the message." : undefined} help="Markdown works.">
          <TextArea value={message} onChange={setMessage} maxLength={MAX_MESSAGE} rows={3} placeholder="Weekly game night starts in an hour!" />
        </Field>
        <div className={styles.split}>
          <Field label="Date" error={timeError}>
            <TextInput type="date" value={date} onChange={setDate} />
          </Field>
          <Field label="Time" hint={TIME_ZONE ? `Your time zone: ${TIME_ZONE}` : "In your local time"}>
            <TextInput type="time" value={time} onChange={setTime} />
          </Field>
          <Field label="Repeat">
            <Select value={repeat} onChange={setRepeat} options={REPEAT_OPTIONS} />
          </Field>
        </div>
        {when && <Banner tone="info">{when}</Banner>}
        {message.trim() && (
          <div>
            <div className={styles.previewLabel}>Preview</div>
            <MessagePreview content={message} author="Taproot" />
          </div>
        )}
      </Stack>
    </Card>
  );
};

export default Announcements;
