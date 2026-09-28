import React, { useState } from "react";
import type { EventsPoll } from "@taproot/gen-shared";
import { eventsServiceClient } from "@taproot/gen-client";
import {
  Badge,
  Button,
  Card,
  ChannelSelect,
  ConfirmDialog,
  DurationInput,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  PageHeader,
  Spinner,
  Stack,
  TextInput,
} from "../../components";
import { cx, formatDateTime, formatRelative, plural, useAction, useRpc, useSession } from "../../lib";
import { channelLabel, LIMITS, NUMBER_EMOJI, useEventsChanged } from "./shared";
import styles from "./events.module.css";

// Polls (moderator+): post a reaction poll and watch the votes live. Members
// vote with the number reactions; a member's latest reaction is their vote.

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Whole percentages, same rounding as the results Taproot posts. */
function percentages(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return counts.map(() => 0);
  const raw = counts.map((c) => (c / total) * 100);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left-- <= 0) break;
    out[i]++;
  }
  return out;
}

const Polls: React.FC = () => {
  const list = useRpc(() => eventsServiceClient.listPolls());
  useEventsChanged("events:polls", () => void list.reload());
  const [ending, setEnding] = useState<EventsPoll | undefined>(undefined);

  const replace = (p: EventsPoll) => {
    const current = list.data?.polls ?? [];
    list.setData({ polls: current.some((x) => x.id === p.id) ? current.map((x) => (x.id === p.id ? p : x)) : [p, ...current] });
  };

  const end = useAction((id: number) => eventsServiceClient.endPoll({ id }), { success: "Poll closed and results posted." });
  const polls = list.data?.polls ?? [];
  const open = polls.filter((p) => !p.closed);
  const closed = polls.filter((p) => p.closed);

  const body = (items: EventsPoll[], emptyTitle: string) =>
    items.length ? (
      <div className={styles.polls}>
        {items.map((p) => (
          <PollResult key={p.id} poll={p} onEnd={() => setEnding(p)} />
        ))}
      </div>
    ) : (
      <EmptyState compact icon={<Icon name="barChart" size={28} />} title={emptyTitle} />
    );

  return (
    <>
      <PageHeader title="Polls" description="Reaction polls with live results. One vote per member." />
      <Stack gap={16}>
        <Creator onCreated={replace} />
        {list.error && !list.data ? (
          <Card>
            <ErrorState message={list.error} onRetry={() => void list.reload()} />
          </Card>
        ) : list.loading && !list.data ? (
          <Spinner block />
        ) : (
          <>
            <Card title="Open" description={open.length ? `${plural(open.length, "poll")} taking votes.` : undefined} padded={false}>
              {body(open, "No open polls")}
            </Card>
            {closed.length > 0 && (
              <Card title="Closed" padded={false}>
                {body(closed, "No closed polls")}
              </Card>
            )}
          </>
        )}
      </Stack>

      <ConfirmDialog
        open={!!ending}
        title="Close this poll?"
        message={ending && `Voting stops and Taproot posts the results in ${channelLabel(ending.channelName)}.`}
        confirmLabel="Close poll"
        busy={end.busy}
        onCancel={() => setEnding(undefined)}
        onConfirm={async () => {
          if (!ending) return;
          const result = await end.run(ending.id);
          if (result) replace(result);
          setEnding(undefined);
        }}
      />
    </>
  );
};

const PollResult: React.FC<{ poll: EventsPoll; onEnd: () => void }> = ({ poll, onEnd }) => {
  const counts = poll.options.map((o) => o.votes);
  const pct = percentages(counts);
  const top = Math.max(0, ...counts);
  return (
    <div className={styles.poll}>
      <div className={styles.pollHead}>
        <div className={styles.pollTitle}>
          <span className="tp-subtle">#{poll.id}</span> {poll.question}
          <div className={styles.meta}>
            {channelLabel(poll.channelName)} · {plural(poll.totalVotes, "vote")} · by {poll.createdBy?.nickname ?? "unknown"} ·{" "}
            {poll.closed
              ? `closed ${formatRelative(poll.closedAtMs)}`
              : poll.endsAtMs
                ? `closes ${formatDateTime(poll.endsAtMs)} (${formatRelative(poll.endsAtMs)})`
                : "open until closed"}
          </div>
        </div>
        {poll.closed ? <Badge>Closed</Badge> : <Button size="sm" onClick={onEnd}>Close now</Button>}
      </div>
      {poll.options.map((o, i) => (
        <div key={i} className={styles.result}>
          <span className={styles.resultLabel}>
            {NUMBER_EMOJI[i]} {o.label}
          </span>
          <span className={styles.resultValue}>
            {pct[i]}% · {o.votes}
          </span>
          <div className={styles.track}>
            <div className={cx(styles.fill, top > 0 && o.votes === top && styles.leader)} style={{ width: `${pct[i]}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
};

const Creator: React.FC<{ onCreated: (p: EventsPoll) => void }> = ({ onCreated }) => {
  const { session } = useSession();
  const [channelId, setChannelId] = useState<string | undefined>(undefined);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [duration, setDuration] = useState<number | undefined>(0);
  const [touched, setTouched] = useState(false);

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const optionsError =
    filled.length < LIMITS.minOptions ? `Give at least ${LIMITS.minOptions} options.` : undefined;
  const durationError = duration === undefined ? "Use e.g. 30m, 2h, 1d (up to 30 days)." : duration > 0 && duration < 60_000 ? "At least 1 minute." : undefined;

  const create = useAction(
    () =>
      eventsServiceClient.createPoll({ channelId: channelId ?? "", question: question.trim(), options: filled, durationMs: duration ?? 0 }),
    { success: (p) => `Poll #${p.id} posted in ${channelLabel(p.channelName)}.` },
  );

  const canCreate = !!channelId && !!question.trim() && !optionsError && !durationError && !create.busy;
  const submit = async () => {
    setTouched(true);
    if (!canCreate) return;
    const result = await create.run();
    if (result) {
      onCreated(result);
      setQuestion("");
      setOptions(["", ""]);
      setTouched(false);
    }
  };

  return (
    <Card
      title="Start a poll"
      description={
        <>
          Same as <span className="tp-mono">{session.prefix}poll Question | option | option</span>.
        </>
      }
      footer={
        <Button variant="primary" icon="barChart" onClick={() => void submit()} loading={create.busy} disabled={touched && !canCreate}>
          Post poll
        </Button>
      }
    >
      <Stack gap={16}>
        <Field label="Question" error={touched && !question.trim() ? "Write the question." : undefined}>
          <TextInput value={question} onChange={setQuestion} maxLength={LIMITS.maxQuestion} placeholder="What should we play Friday?" />
        </Field>
        <Field label="Options" error={touched ? optionsError : undefined} help={`${LIMITS.minOptions} to ${LIMITS.maxOptions} options.`}>
          <Stack gap={8}>
            {options.map((o, i) => (
              <div key={i} className={styles.optionRow}>
                <span className={styles.optionNumber}>{NUMBER_EMOJI[i]}</span>
                <TextInput
                  value={o}
                  onChange={(v) => setOptions(options.map((x, j) => (j === i ? v : x)))}
                  maxLength={LIMITS.maxOption}
                  placeholder={`Option ${i + 1}`}
                  aria-label={`Option ${i + 1}`}
                />
                <IconButton
                  icon="trash"
                  label={`Remove option ${i + 1}`}
                  disabled={options.length <= LIMITS.minOptions}
                  onClick={() => setOptions(options.filter((_, j) => j !== i))}
                />
              </div>
            ))}
            {options.length < LIMITS.maxOptions && (
              <div>
                <Button size="sm" icon="plus" variant="quiet" onClick={() => setOptions([...options, ""])}>
                  Add option
                </Button>
              </div>
            )}
          </Stack>
        </Field>
        <div className={styles.split}>
          <Field label="Channel" error={touched && !channelId ? "Pick a channel." : undefined}>
            <ChannelSelect value={channelId} onChange={setChannelId} placeholder="Pick a channel" />
          </Field>
          <Field label="Closes after" error={durationError} help="Leave empty to keep it open until you close it.">
            <DurationInput
              value={duration}
              onChange={setDuration}
              emptyLabel="Until closed by hand"
              max={LIMITS.pollMaxMs}
              presets={[HOUR, 6 * HOUR, DAY, 3 * DAY]}
            />
          </Field>
        </div>
      </Stack>
    </Card>
  );
};

export default Polls;
