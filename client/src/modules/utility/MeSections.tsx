import React, { useEffect, useState } from "react";
import { utilityServiceClient } from "@taproot/gen-client";
import { Button, Card, Chip, EmptyState, ErrorState, Field, Icon, Row, Spinner, Stack, TextInput } from "../../components";
import { formatRelative, useAction, useRpc, useSession } from "../../lib";
import { MAX_AFK_MESSAGE, MAX_KEYWORD, useUtilityChanged } from "./shared";

// Cards on every member's Me page: their AFK note and highlight keywords.
// Same rules as "afk" and "highlight add/remove/clear".

export const AfkSection: React.FC = () => {
  const { session } = useSession();
  const status = useRpc(() => utilityServiceClient.getMyAfk());
  useUtilityChanged(["utility:afk"], () => void status.reload());
  const [message, setMessage] = useState("");

  const set = useAction(() => utilityServiceClient.setMyAfk({ message }), { success: "You're now AFK." });
  const clear = useAction(() => utilityServiceClient.clearMyAfk(), { success: "Welcome back! AFK cleared." });

  const afk = status.data?.afk ?? false;
  useEffect(() => {
    if (status.data?.afk) setMessage(status.data.message);
  }, [status.data?.afk, status.data?.message]);

  let body: React.ReactNode;
  if (status.error && !status.data) {
    body = <ErrorState compact message={status.error} onRetry={() => void status.reload()} />;
  } else if (!status.data) {
    body = <Spinner block />;
  } else {
    const save = async () => {
      const result = await set.run();
      if (result) status.setData(result);
    };
    body = (
      <Stack gap={12}>
        {afk && (
          <div className="tp-subtle">
            <Icon name="clock" size={14} /> AFK since {formatRelative(status.data.sinceAtMs)}: {status.data.message}
          </div>
        )}
        <Field label="Message" help="Shown to anyone who mentions you. It clears the next time you post.">
          <TextInput value={message} onChange={setMessage} onEnter={save} maxLength={MAX_AFK_MESSAGE} placeholder="Grabbing lunch, back soon" />
        </Field>
        <Row gap={8}>
          <Button variant="primary" onClick={save} loading={set.busy} disabled={clear.busy}>
            {afk ? "Update" : "Go AFK"}
          </Button>
          {afk && (
            <Button
              variant="secondary"
              loading={clear.busy}
              disabled={set.busy}
              onClick={async () => {
                const result = await clear.run();
                if (result) {
                  status.setData(result);
                  setMessage("");
                }
              }}
            >
              I'm back
            </Button>
          )}
        </Row>
      </Stack>
    );
  }

  return (
    <Card
      title="AFK"
      description={
        <>
          Let people know you're away. You can also type <span className="tp-mono">{session.prefix}afk your message</span> in chat.
        </>
      }
    >
      {body}
    </Card>
  );
};

export const HighlightsSection: React.FC = () => {
  const { session } = useSession();
  const list = useRpc(() => utilityServiceClient.listMyHighlights());
  useUtilityChanged(["utility:highlights"], () => void list.reload());
  const [keyword, setKeyword] = useState("");

  const add = useAction((k: string) => utilityServiceClient.addMyHighlight({ keyword: k }), { success: "Keyword added." });
  const remove = useAction((k: string) => utilityServiceClient.removeMyHighlight({ keyword: k }));
  const clear = useAction(() => utilityServiceClient.clearMyHighlights(), { success: "Cleared your keywords." });

  const keywords = list.data?.keywords ?? [];
  const max = list.data?.max ?? 25;
  const full = keywords.length >= max;

  const submit = async () => {
    if (!keyword.trim() || full) return;
    const result = await add.run(keyword);
    if (result) {
      list.setData(result);
      setKeyword("");
    }
  };

  let body: React.ReactNode;
  if (list.error && !list.data) {
    body = <ErrorState compact message={list.error} onRetry={() => void list.reload()} />;
  } else if (!list.data) {
    body = <Spinner block />;
  } else {
    body = (
      <Stack gap={12}>
        <Row gap={8} align="end">
          <div style={{ flex: "1 1 auto" }}>
            <Field label="Add a keyword" help="Whole words, ignoring case. Phrases work too.">
              <TextInput
                value={keyword}
                onChange={setKeyword}
                onEnter={submit}
                maxLength={MAX_KEYWORD}
                placeholder={full ? `You have the maximum of ${max}` : "e.g. your name or a game"}
                disabled={full}
              />
            </Field>
          </div>
          <Button variant="primary" icon="plus" onClick={submit} loading={add.busy} disabled={!keyword.trim() || full}>
            Add
          </Button>
        </Row>
        {keywords.length === 0 ? (
          <EmptyState
            compact
            icon={<Icon name="bell" size={28} />}
            title="No keywords yet"
            description="Taproot will send you a notification when one of your keywords comes up in a channel you can see."
          />
        ) : (
          <>
            <Row gap={6} wrap>
              {keywords.map((k) => (
                <Chip
                  key={k}
                  label={k}
                  onRemove={async () => {
                    const result = await remove.run(k);
                    if (result) list.setData(result);
                  }}
                />
              ))}
            </Row>
            <Row justify="between" align="center">
              <span className="tp-subtle">
                {keywords.length} of {max} keywords
              </span>
              <Button
                size="sm"
                variant="quiet"
                loading={clear.busy}
                onClick={async () => {
                  const result = await clear.run();
                  if (result) list.setData(result);
                }}
              >
                Clear all
              </Button>
            </Row>
          </>
        )}
      </Stack>
    );
  }

  return (
    <Card
      title="Highlights"
      description={
        <>
          Get notified when someone mentions a keyword, unless you were chatting in that channel in the last 5 minutes. At most one
          notification per channel every 5 minutes. In chat: <span className="tp-mono">{session.prefix}highlight add word</span>.
        </>
      }
    >
      {body}
    </Card>
  );
};
