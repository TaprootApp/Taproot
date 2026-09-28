import React, { useEffect, useRef, useState } from "react";
import type { EventsStarboardConfig } from "@taproot/gen-shared";
import { eventsServiceClient } from "@taproot/gen-client";
import {
  Banner,
  Button,
  Card,
  ChannelMultiSelect,
  ChannelSelect,
  ErrorState,
  Field,
  NumberInput,
  PageHeader,
  Spinner,
  Stack,
  Stat,
  TextInput,
  Toggle,
} from "../../components";
import { useAction, useRpc, useSession } from "../../lib";
import { LIMITS, useEventsChanged } from "./shared";
import styles from "./events.module.css";

// Starboard settings (admin). Same settings as the "starboard" command.

const SHORTCODE = /^:[^:\s]+:$/;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const Starboard: React.FC = () => {
  const { session } = useSession();
  const view = useRpc(() => eventsServiceClient.getStarboard());
  const [base, setBase] = useState<EventsStarboardConfig | undefined>(undefined);
  const [draft, setDraft] = useState<EventsStarboardConfig | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const dirty = !!draft && !!base && !same(draft, base);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Newer settings (another admin, a text command) replace a clean form and
  // are held back from a dirty one, so edits are never lost.
  useEffect(() => {
    const fresh = view.data?.config;
    if (!fresh) return;
    if (!dirtyRef.current) {
      setBase(fresh);
      setDraft(fresh);
      setStale(false);
    } else if (!same(fresh, base)) {
      setStale(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.data]);

  useEventsChanged("events:starboard", () => void view.reload());

  const save = useAction((config: EventsStarboardConfig) => eventsServiceClient.updateStarboard(config), {
    success: "Settings saved",
  });

  if (!draft) {
    return (
      <Stack>
        <PageHeader title="Starboard" />
        {view.error ? <ErrorState message={view.error} onRetry={() => void view.reload()} /> : <Spinner block label="Loading settings…" />}
      </Stack>
    );
  }

  const patch = (change: Partial<EventsStarboardConfig>) => setDraft({ ...draft, ...change });
  const emojiError = SHORTCODE.test(draft.emoji.trim()) ? undefined : "Write the emoji as a :shortcode:, like :star:.";
  const channelError = draft.enabled && !draft.channelId ? "Pick a starboard channel to turn it on." : undefined;
  const invalid = emojiError ?? channelError;
  const stats = view.data?.stats;

  const discard = () => {
    const latest = view.data?.config ?? base;
    setBase(latest);
    setDraft(latest);
    setStale(false);
    save.reset();
  };
  const submit = async () => {
    const result = await save.run({ ...draft, emoji: draft.emoji.trim() });
    if (result?.config) {
      view.setData(result);
      setBase(result.config);
      setDraft(result.config);
      setStale(false);
    }
  };

  return (
    <Stack>
      <PageHeader
        title="Starboard"
        description="When a message collects enough reactions, Taproot reposts it to a starboard channel and keeps the count up to date."
      />
      {stale && (
        <Banner tone="warning" title="Changed elsewhere" action={<Button size="sm" onClick={discard}>Reload</Button>}>
          Someone else saved these settings while you were editing. Reload to see their version, or save to overwrite it.
        </Banner>
      )}
      {save.error && (
        <Banner tone="error" title="Couldn't save">
          {save.error}
        </Banner>
      )}
      {stats && (
        <div className={styles.stats}>
          <Stat label="Messages on the board" value={stats.posts.toLocaleString()} />
          <Stat label="Stars on them" value={stats.totalStars.toLocaleString()} tone="brand" />
        </div>
      )}

      <Card title="Starboard">
        <Stack gap={16}>
          <Toggle
            checked={draft.enabled}
            onChange={(enabled) => patch({ enabled })}
            label="Starboard on"
            description={
              <>
                Or <span className="tp-mono">{session.prefix}starboard on</span> in chat.
              </>
            }
          />
          <Field label="Starboard channel" error={channelError} help="Taproot needs permission to post there.">
            <ChannelSelect value={draft.channelId} onChange={(channelId) => patch({ channelId })} noneLabel="Not set" />
          </Field>
          <div className={styles.split}>
            <Field label="Emoji" error={emojiError} help="A :shortcode:. Community emoji work too.">
              <TextInput value={draft.emoji} onChange={(emoji) => patch({ emoji })} spellCheck={false} autoComplete="off" />
            </Field>
            <Field label="Threshold" help="Distinct members who reacted, on the original or the starboard copy.">
              <NumberInput
                value={draft.threshold}
                onChange={(threshold) => patch({ threshold })}
                min={1}
                max={LIMITS.maxThreshold}
                suffix="reactions"
              />
            </Field>
          </div>
        </Stack>
      </Card>

      <Card title="Rules">
        <Stack gap={16}>
          <Toggle
            checked={draft.selfStar}
            onChange={(selfStar) => patch({ selfStar })}
            label="Count the author's own reaction"
            description="Off by default, so members can't star themselves onto the board."
          />
          <Toggle
            checked={draft.removeBelowThreshold}
            onChange={(removeBelowThreshold) => patch({ removeBelowThreshold })}
            label="Remove posts that drop below the threshold"
            description="When off, the post stays and just shows the lower count."
          />
          <Field label="Ignored channels" help="Messages here never reach the starboard. The starboard channel itself is always ignored.">
            <ChannelMultiSelect
              value={draft.ignoredChannelIds}
              onChange={(ignoredChannelIds) => patch({ ignoredChannelIds })}
              emptyText="No ignored channels"
            />
          </Field>
          <p className={styles.hint}>
            Deleting a starboard post keeps that message off the board for good. Deleting the original removes its post.
          </p>
        </Stack>
      </Card>

      {(dirty || save.busy) && (
        <div className={styles.saveBar} role="region" aria-label="Unsaved changes">
          <span className={styles.saveText}>{invalid ?? "You have unsaved changes."}</span>
          <div className={styles.saveActions}>
            <Button variant="quiet" onClick={discard} disabled={save.busy}>
              Discard
            </Button>
            <Button variant="primary" onClick={() => void submit()} loading={save.busy} disabled={!!invalid}>
              Save changes
            </Button>
          </div>
        </div>
      )}
    </Stack>
  );
};

export default Starboard;
