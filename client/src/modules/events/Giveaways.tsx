import React, { useState } from "react";
import type { EventsGiveaway } from "@taproot/gen-shared";
import { EventsGiveawayState } from "@taproot/gen-shared";
import { eventsServiceClient } from "@taproot/gen-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  ChannelSelect,
  ConfirmDialog,
  DurationInput,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  NumberInput,
  PageHeader,
  RoleSelect,
  Stack,
  Table,
  TextInput,
} from "../../components";
import type { Column } from "../../components";
import { formatDateTime, formatRelative, plural, useAction, useRoles, useRpc, useSession } from "../../lib";
import { channelLabel, GIVEAWAY_STATE_LABEL, GIVEAWAY_STATE_TONE, LIMITS, useEventsChanged } from "./shared";
import styles from "./events.module.css";

// Giveaways (moderator+): start one, watch entries come in, end it early,
// reroll winners or cancel it. Same actions as "giveaway start/end/reroll/cancel".

const HOUR = 3_600_000;
const DAY = 86_400_000;

type Pending = { kind: "end" | "cancel" | "reroll"; giveaway: EventsGiveaway };

const Giveaways: React.FC = () => {
  const list = useRpc(() => eventsServiceClient.listGiveaways());
  useEventsChanged("events:giveaways", () => void list.reload());
  const roles = useRoles();
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [rerollCount, setRerollCount] = useState(1);

  const replace = (g: EventsGiveaway) => {
    const current = list.data?.giveaways ?? [];
    list.setData({ giveaways: current.some((x) => x.id === g.id) ? current.map((x) => (x.id === g.id ? g : x)) : [g, ...current] });
  };

  const end = useAction((id: number) => eventsServiceClient.endGiveaway({ id }), {
    success: (g) => `Giveaway #${g.id} ended with ${plural(g.winners.length, "winner")}.`,
  });
  const cancel = useAction((id: number) => eventsServiceClient.cancelGiveaway({ id }), { success: "Giveaway cancelled." });
  const reroll = useAction((id: number, count: number) => eventsServiceClient.rerollGiveaway({ id, count }), {
    success: "New winners drawn and announced.",
  });

  const giveaways = list.data?.giveaways ?? [];
  const running = giveaways.filter((g) => g.state === EventsGiveawayState.RUNNING).length;

  const columns: Column<EventsGiveaway>[] = [
    {
      key: "prize",
      header: "Prize",
      wrap: true,
      render: (g) => (
        <div>
          <div className={styles.prize}>
            <span className="tp-subtle">#{g.id}</span> {g.prize}
          </div>
          <div className={styles.meta}>
            {channelLabel(g.channelName)} · {plural(g.winnerCount, "winner")} · by {g.host?.nickname ?? "unknown"}
            {g.requiredRoleId ? ` · needs ${roles.byId.get(g.requiredRoleId)?.name ?? "a role"}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "state",
      header: "Status",
      width: "100px",
      render: (g) => <Badge tone={GIVEAWAY_STATE_TONE[g.state]}>{GIVEAWAY_STATE_LABEL[g.state]}</Badge>,
    },
    { key: "entries", header: "Entries", width: "80px", align: "right", render: (g) => g.entryCount.toLocaleString() },
    {
      key: "when",
      header: "Ends",
      width: "150px",
      hideOnMobile: true,
      render: (g) => {
        const at = g.state === EventsGiveawayState.RUNNING ? g.endsAtMs : g.endedAtMs || g.endsAtMs;
        return (
          <div>
            <div>{formatDateTime(at)}</div>
            <div className="tp-subtle">{formatRelative(at)}</div>
          </div>
        );
      },
    },
    {
      key: "winners",
      header: "Winners",
      wrap: true,
      hideOnMobile: true,
      render: (g) =>
        g.winners.length ? (
          g.winners.map((w) => w.nickname).join(", ")
        ) : (
          <span className="tp-subtle">{g.state === EventsGiveawayState.ENDED ? "None eligible" : "—"}</span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "170px",
      render: (g) => (
        <div className={styles.cellActions}>
          {g.state === EventsGiveawayState.RUNNING && (
            <>
              <Button size="sm" onClick={() => setPending({ kind: "end", giveaway: g })}>
                End now
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setPending({ kind: "cancel", giveaway: g })}>
                Cancel
              </Button>
            </>
          )}
          {g.state === EventsGiveawayState.ENDED && (
            <Button
              size="sm"
              icon="refresh"
              onClick={() => {
                setRerollCount(1);
                setPending({ kind: "reroll", giveaway: g });
              }}
            >
              Reroll
            </Button>
          )}
        </div>
      ),
    },
  ];

  const busy = end.busy || cancel.busy || reroll.busy;
  const confirm = async () => {
    if (!pending) return;
    const id = pending.giveaway.id;
    const result =
      pending.kind === "end" ? await end.run(id) : pending.kind === "cancel" ? await cancel.run(id) : await reroll.run(id, rerollCount);
    if (result) replace(result);
    setPending(undefined);
  };

  return (
    <>
      <PageHeader title="Giveaways" description="Members enter by reacting with 🎉. Taproot draws the winners when time is up." />
      <Stack gap={16}>
        <Starter onCreated={replace} />
        <Card
          title="Giveaways"
          description={giveaways.length ? `${plural(running, "giveaway")} running. Times are in your local time.` : undefined}
          padded={false}
        >
          {list.error && !list.data ? (
            <ErrorState message={list.error} onRetry={() => void list.reload()} />
          ) : (
            <Table
              columns={columns}
              rows={giveaways}
              rowKey={(g) => g.id}
              loading={list.loading}
              empty={
                <EmptyState
                  compact
                  icon={<Icon name="gift" size={28} />}
                  title="No giveaways yet"
                  description="Start one above, or with the giveaway start command."
                />
              }
            />
          )}
        </Card>
      </Stack>

      <ConfirmDialog
        open={!!pending}
        title={
          pending?.kind === "end" ? "End the giveaway now?" : pending?.kind === "cancel" ? "Cancel the giveaway?" : "Reroll winners?"
        }
        message={
          pending &&
          (pending.kind === "end"
            ? `Taproot draws ${plural(pending.giveaway.winnerCount, "winner")} for "${pending.giveaway.prize}" right away and announces them.`
            : pending.kind === "cancel"
              ? `No winners are drawn for "${pending.giveaway.prize}". This can't be undone.`
              : "Taproot draws new winners from the entrants who haven't won yet and announces them in the channel.")
        }
        confirmLabel={pending?.kind === "end" ? "End and draw" : pending?.kind === "cancel" ? "Cancel giveaway" : "Reroll"}
        danger={pending?.kind === "cancel"}
        busy={busy}
        onCancel={() => setPending(undefined)}
        onConfirm={() => void confirm()}
      >
        {pending?.kind === "reroll" && (
          <Field label="New winners">
            <NumberInput value={rerollCount} onChange={setRerollCount} min={1} max={LIMITS.maxWinners} />
          </Field>
        )}
      </ConfirmDialog>
    </>
  );
};

const Starter: React.FC<{ onCreated: (g: EventsGiveaway) => void }> = ({ onCreated }) => {
  const { session } = useSession();
  const [channelId, setChannelId] = useState<string | undefined>(undefined);
  const [prize, setPrize] = useState("");
  const [winners, setWinners] = useState(1);
  const [duration, setDuration] = useState<number | undefined>(DAY);
  const [roleId, setRoleId] = useState<string | undefined>(undefined);
  const [touched, setTouched] = useState(false);

  const create = useAction(
    () =>
      eventsServiceClient.createGiveaway({
        channelId: channelId ?? "",
        prize: prize.trim(),
        winnerCount: winners,
        durationMs: duration ?? 0,
        requiredRoleId: roleId,
      }),
    { success: (g) => `Giveaway #${g.id} started in ${channelLabel(g.channelName)}.` },
  );

  const durationError = !duration || duration < 60_000 ? "Pick a duration of at least 1 minute." : undefined;
  const canCreate = !!channelId && !!prize.trim() && !durationError && !create.busy;
  const submit = async () => {
    setTouched(true);
    if (!canCreate) return;
    const result = await create.run();
    if (result) {
      onCreated(result);
      setPrize("");
      setTouched(false);
    }
  };

  return (
    <Card
      title="Start a giveaway"
      description={
        <>
          Same as <span className="tp-mono">{session.prefix}giveaway start</span>. Winners must still be members (and hold the
          required role) when the draw happens.
        </>
      }
      footer={
        <Button variant="primary" icon="gift" onClick={() => void submit()} loading={create.busy} disabled={touched && !canCreate}>
          Start giveaway
        </Button>
      }
    >
      <Stack gap={16}>
        <Field label="Prize" error={touched && !prize.trim() ? "Say what the prize is." : undefined}>
          <TextInput value={prize} onChange={setPrize} maxLength={LIMITS.maxPrize} placeholder="Steam gift card" />
        </Field>
        <div className={styles.split}>
          <Field label="Channel" error={touched && !channelId ? "Pick a channel." : undefined}>
            <ChannelSelect value={channelId} onChange={setChannelId} placeholder="Pick a channel" />
          </Field>
          <Field label="Winners">
            <NumberInput value={winners} onChange={setWinners} min={1} max={LIMITS.maxWinners} />
          </Field>
        </div>
        <div className={styles.split}>
          <Field label="Runs for" error={touched ? durationError : undefined}>
            <DurationInput
              value={duration}
              onChange={setDuration}
              allowEmpty={false}
              max={LIMITS.giveawayMaxMs}
              presets={[HOUR, 12 * HOUR, DAY, 3 * DAY, 7 * DAY]}
            />
          </Field>
          <Field label="Required role" help="Optional. Checked when the winners are drawn.">
            <RoleSelect value={roleId} onChange={setRoleId} noneLabel="Anyone can win" />
          </Field>
        </div>
        {duration && !durationError ? (
          <Banner tone="info">Ends around {formatDateTime(Date.now() + duration)}, accurate to about a minute.</Banner>
        ) : null}
      </Stack>
    </Card>
  );
};

export default Giveaways;
