import React, { useEffect, useState } from "react";
import type { FeedsFeed, FeedsList } from "@taproot/gen-shared";
import { FeedsKind } from "@taproot/gen-shared";
import { feedsServiceClient } from "@taproot/gen-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  MessagePreview,
  Modal,
  NumberInput,
  PageHeader,
  RoleSelect,
  Row,
  Select,
  Stack,
  Table,
  TextArea,
  TextInput,
  Toggle,
} from "../../components";
import type { Column } from "../../components";
import { formatRelative, plural, truncate, useAction, useRpc } from "../../lib";
import { appendToken, PlaceholderHelp } from "../../views/content/shared";
import {
  FEED_PLACEHOLDERS,
  FeedChannelSelect,
  KIND_HELP,
  KIND_LABEL,
  KINDS,
  useFeedChannels,
  useFeedsChanged,
} from "./shared";
import styles from "./feeds.module.css";

// Feeds (admin): YouTube uploads, Reddit posts, and Twitch/Kick go-live
// alerts posted to a channel. Same rules as "feed add/remove/test"; the
// server resolves and re-checks everything. Also holds the check interval
// and the Twitch credentials (the secret is write-only).

const MAX_TEMPLATE = 2000;

function defaultTemplate(list: FeedsList | undefined, kind: FeedsKind): string {
  return list?.defaultTemplates[KINDS.indexOf(kind)] ?? "";
}

function status(f: FeedsFeed): React.ReactNode {
  if (!f.enabled) return <Badge tone="neutral">Paused</Badge>;
  if (f.lastError) return <Badge tone={f.failures > 2 ? "danger" : "warning"}>Error</Badge>;
  if (!f.lastCheckAtMs) return <Badge tone="info">Starting</Badge>;
  return <Badge tone="success">OK</Badge>;
}

const Feeds: React.FC = () => {
  const list = useRpc(() => feedsServiceClient.listFeeds());
  const channels = useFeedChannels();
  useFeedsChanged(["feeds:feeds"], () => void list.reload());

  // undefined = closed, null = new feed.
  const [editing, setEditing] = useState<FeedsFeed | null | undefined>(undefined);
  const [removing, setRemoving] = useState<FeedsFeed | undefined>(undefined);
  const [testingId, setTestingId] = useState<number | undefined>(undefined);

  const remove = useAction((id: number) => feedsServiceClient.removeFeed({ id }), { success: "Feed removed." });
  const test = useAction((id: number) => feedsServiceClient.testFeed({ id }), { success: (r) => r.result });

  const feeds = list.data?.feeds ?? [];

  const columns: Column<FeedsFeed>[] = [
    {
      key: "source",
      header: "Feed",
      render: (f) => (
        <div className={styles.source}>
          <span className={styles.sourceName} title={f.label}>
            {f.label}
          </span>
          <span className={styles.sourceSub}>
            {KIND_LABEL[f.kind] ?? "Feed"} · #{f.channelName}
          </span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "30%",
      hideOnMobile: true,
      wrap: true,
      render: (f) => (
        <Stack gap={2}>
          <span>
            {status(f)}{" "}
            <span className="tp-subtle">
              {f.lastCheckAtMs ? `checked ${formatRelative(f.lastCheckAtMs)}` : f.enabled ? "first check soon" : ""}
            </span>
          </span>
          {f.lastError && (
            <span className={styles.error} title={f.lastError}>
              {truncate(f.lastError, 120)}
            </span>
          )}
        </Stack>
      ),
    },
    {
      key: "posted",
      header: "Last post",
      width: "110px",
      hideOnMobile: true,
      render: (f) => <span className="tp-subtle">{f.lastPostAtMs ? formatRelative(f.lastPostAtMs) : "never"}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "124px",
      render: (f) => (
        <div className={styles.cellActions} onClick={(e) => e.stopPropagation()}>
          <IconButton
            icon="send"
            label="Post a test"
            loading={test.busy && testingId === f.id}
            disabled={test.busy}
            onClick={async () => {
              setTestingId(f.id);
              await test.run(f.id);
              setTestingId(undefined);
            }}
          />
          <IconButton icon="edit" label={`Edit ${f.label}`} onClick={() => setEditing(f)} />
          <IconButton icon="trash" label={`Remove ${f.label}`} danger onClick={() => setRemoving(f)} />
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Feeds"
        description="Post new YouTube uploads, Reddit posts, and Twitch or Kick go-live alerts in a channel."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setEditing(null)} disabled={!list.data}>
            New feed
          </Button>
        }
      />

      <Stack gap={16}>
        {list.error && !list.data ? (
          <Card>
            <ErrorState message={list.error} onRetry={() => void list.reload()} />
          </Card>
        ) : (
          <Card padded={false}>
            <Table
              columns={columns}
              rows={feeds}
              rowKey={(f) => f.id}
              onRowClick={(f) => setEditing(f)}
              loading={list.loading}
              empty={
                <EmptyState
                  icon={<Icon name="rss" size={28} />}
                  title="No feeds yet"
                  description="Add one and Taproot posts whatever's new from then on. Nothing from before is posted."
                  action={
                    <Button variant="primary" icon="plus" onClick={() => setEditing(null)} disabled={!list.data}>
                      New feed
                    </Button>
                  }
                />
              }
            />
          </Card>
        )}
        {list.data && (
          <p className="tp-subtle">
            {plural(feeds.length, "feed")} · checked about every {list.data.pollMinutes} minutes. Failing feeds are retried less
            often until they work again. TikTok has no public API, so it can't be followed.
          </p>
        )}
        <FeedSettings />
      </Stack>

      {editing !== undefined && list.data && (
        <FeedEditor
          feed={editing ?? undefined}
          list={list.data}
          channels={channels}
          onClose={() => setEditing(undefined)}
          onSaved={(result) => {
            list.setData(result);
            setEditing(undefined);
          }}
        />
      )}

      <ConfirmDialog
        open={!!removing}
        title="Remove feed?"
        message={removing && <>Taproot will stop posting from {removing.label}.</>}
        confirmLabel="Remove"
        danger
        busy={remove.busy}
        onCancel={() => setRemoving(undefined)}
        onConfirm={async () => {
          if (!removing) return;
          const result = await remove.run(removing.id);
          if (result) list.setData(result);
          setRemoving(undefined);
        }}
      />
    </>
  );
};

const FeedEditor: React.FC<{
  feed: FeedsFeed | undefined;
  list: FeedsList;
  channels: ReturnType<typeof useFeedChannels>;
  onClose: () => void;
  onSaved: (list: FeedsList) => void;
}> = ({ feed, list, channels, onClose, onSaved }) => {
  const [kind, setKind] = useState<FeedsKind>(feed?.kind ?? FeedsKind.YOUTUBE);
  const [source, setSource] = useState("");
  const [channelId, setChannelId] = useState<string | undefined>(feed?.channelId);
  const [roleId, setRoleId] = useState<string | undefined>(feed?.roleId || undefined);
  const [template, setTemplate] = useState(feed?.template ?? "");
  const [enabled, setEnabled] = useState(feed?.enabled ?? true);
  const [touched, setTouched] = useState(false);

  const save = useAction(
    () =>
      feed
        ? feedsServiceClient.updateFeed({ id: feed.id, channelId: channelId ?? "", roleId: roleId ?? "", template, enabled })
        : feedsServiceClient.addFeed({ kind, source, channelId: channelId ?? "", roleId: roleId ?? "", template }),
    { success: feed ? "Feed saved." : "Feed added. New items will be posted from now on.", toastError: false },
  );

  const needsTwitch = !feed && kind === FeedsKind.TWITCH && !list.twitchConfigured;
  const canSave = (!!feed || !!source.trim()) && !!channelId && template.length <= MAX_TEMPLATE && !needsTwitch && !save.busy;
  const effective = template.trim() || defaultTemplate(list, kind);

  const submit = async () => {
    setTouched(true);
    if (!canSave) return;
    const result = await save.run();
    if (result) onSaved(result);
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!save.busy}
      size="lg"
      title={feed ? `Edit ${feed.label}` : "New feed"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.busy} disabled={!canSave}>
            {feed ? "Save" : "Add feed"}
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        {feed ? (
          <Field label="Following">
            <div>
              {KIND_LABEL[feed.kind]} ·{" "}
              <a className="tp-link" href={feed.sourceUrl} target="_blank" rel="noreferrer">
                {feed.label}
              </a>
            </div>
          </Field>
        ) : (
          <>
            <Field label="Platform">
              <Select
                value={kind}
                onChange={(v) => setKind(v)}
                options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
              />
            </Field>
            {needsTwitch && <Banner tone="warning">Add your Twitch client ID and secret below the feeds list first.</Banner>}
            <Field
              label="Follow"
              help={KIND_HELP[kind].help}
              error={touched && !source.trim() ? "Enter what to follow." : undefined}
            >
              <TextInput
                value={source}
                onChange={setSource}
                onEnter={submit}
                placeholder={KIND_HELP[kind].placeholder}
                maxLength={300}
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
              />
            </Field>
          </>
        )}
        <Field label="Post in" error={touched && !channelId ? "Pick a channel." : undefined}>
          <FeedChannelSelect
            channels={channels.data?.channels}
            loading={channels.loading}
            error={channels.error}
            onRetry={() => void channels.reload()}
            voice={false}
            value={channelId}
            onChange={setChannelId}
          />
        </Field>
        <Field label="Mention" hint="Optional" help="Pinged with every post. Leave empty for no mention.">
          <RoleSelect value={roleId} onChange={setRoleId} noneLabel="No mention" />
        </Field>
        <Field
          label="Message"
          hint="Optional"
          help="Leave empty for the default shown in the preview. Click a placeholder to add it."
          error={template.length > MAX_TEMPLATE ? `Keep it under ${MAX_TEMPLATE} characters.` : undefined}
        >
          <TextArea value={template} onChange={setTemplate} maxLength={MAX_TEMPLATE} rows={3} placeholder={defaultTemplate(list, kind)} />
        </Field>
        <PlaceholderHelp placeholders={FEED_PLACEHOLDERS} onInsert={(t) => setTemplate((v) => appendToken(v || defaultTemplate(list, kind), t))} />
        <div>
          <div className={styles.previewLabel}>Preview</div>
          <MessagePreview content={effective} author="Taproot" placeholders />
        </div>
        {feed && (
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            label="Active"
            description="Paused feeds aren't checked. Turning one back on skips anything posted while it was paused."
          />
        )}
        {feed?.lastError && <Banner tone="warning" title="Last check">{feed.lastError}</Banner>}
        {save.error && <Banner tone="error">{save.error}</Banner>}
      </Stack>
    </Modal>
  );
};

/** Check interval and Twitch credentials. */
const FeedSettings: React.FC = () => {
  const settings = useRpc(() => feedsServiceClient.getSettings());
  useFeedsChanged(["feeds:settings"], () => void settings.reload());
  const [poll, setPoll] = useState(10);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");

  useEffect(() => {
    if (!settings.data) return;
    setPoll(settings.data.pollMinutes);
    setClientId(settings.data.twitchClientId);
    setSecret("");
  }, [settings.data]);

  const save = useAction(
    (clear: boolean) =>
      feedsServiceClient.saveSettings({ pollMinutes: poll, twitchClientId: clientId, twitchClientSecret: secret, clearTwitch: clear }),
    { success: (_r) => "Feed settings saved." },
  );

  if (settings.error && !settings.data) {
    return (
      <Card title="Feed settings">
        <ErrorState compact message={settings.error} onRetry={() => void settings.reload()} />
      </Card>
    );
  }
  const data = settings.data;
  const dirty = !!data && (poll !== data.pollMinutes || clientId.trim() !== data.twitchClientId || !!secret.trim());

  const run = async (clear: boolean) => {
    const result = await save.run(clear);
    if (result) settings.setData(result);
  };

  return (
    <Card
      title="Feed settings"
      description="How often feeds are checked, and the Twitch app Taproot uses to see who's live."
      footer={
        <Row gap={8}>
          {data?.twitchSecretSet && (
            <Button variant="quiet" onClick={() => void run(true)} disabled={save.busy}>
              Remove Twitch credentials
            </Button>
          )}
          <Button variant="primary" onClick={() => void run(false)} loading={save.busy} disabled={!dirty}>
            Save
          </Button>
        </Row>
      }
    >
      <Stack gap={16}>
        <Field label="Check every" help="5 minutes at the least. Each feed is checked on its own schedule.">
          <NumberInput value={poll} onChange={setPoll} min={5} max={1440} suffix="minutes" disabled={!data} />
        </Field>
        <Field
          label="Twitch client ID"
          hint="For Twitch feeds"
          help={
            <>
              Register an app at{" "}
              <a className="tp-link" href="https://dev.twitch.tv/console/apps" target="_blank" rel="noreferrer">
                dev.twitch.tv/console/apps
              </a>{" "}
              (any redirect URL, category "Other"), then copy its client ID and a new secret here.
            </>
          }
        >
          <TextInput value={clientId} onChange={setClientId} maxLength={64} spellCheck={false} autoComplete="off" disabled={!data} />
        </Field>
        <Field
          label="Twitch client secret"
          hint={data?.twitchSecretSet ? "Saved" : undefined}
          help={data?.twitchSecretSet ? "Saved and hidden. Type a new one to replace it." : "Stored on Taproot's server and never shown again."}
        >
          <TextInput
            type="password"
            value={secret}
            onChange={setSecret}
            maxLength={200}
            placeholder={data?.twitchSecretSet ? "••••••••••••" : ""}
            autoComplete="new-password"
            spellCheck={false}
            disabled={!data}
          />
        </Field>
      </Stack>
    </Card>
  );
};

export default Feeds;
