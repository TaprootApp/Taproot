import React, { useState } from "react";
import type { EngagementLeaderboardEntry, EngagementMemberStats } from "@taproot/gen-shared";
import { EngagementBoard } from "@taproot/gen-shared";
import { engagementServiceClient } from "@taproot/gen-client";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Modal,
  NumberInput,
  PageHeader,
  Select,
  Stack,
  Table,
  Tabs,
} from "../../components";
import type { Column } from "../../components";
import { NavLink, plural, useAction, useRpc, useSession } from "../../lib";
import { AREA, formatMoney, MEDALS, useEngagementChanged } from "./shared";
import styles from "./engagement.module.css";

// Leaderboards (everyone): levels and the currency, 25 per page. Admins can
// click a member to give, take or set their XP or balance, and reset a board.

type BoardKey = "levels" | "money";

const Leaderboard: React.FC = () => {
  const { isAdmin, session } = useSession();
  const [tab, setTab] = useState<BoardKey>("levels");
  const [page, setPage] = useState(1);
  const board = tab === "money" ? EngagementBoard.MONEY : EngagementBoard.LEVELS;
  const list = useRpc(() => engagementServiceClient.getLeaderboard({ board, page }), [board, page]);
  useEngagementChanged([tab === "money" ? AREA.money : AREA.xp, AREA.config], () => void list.reload());

  const [adjusting, setAdjusting] = useState<EngagementLeaderboardEntry | undefined>(undefined);
  const [resetting, setResetting] = useState(false);
  const reset = useAction(() => engagementServiceClient.resetBoard({ board }), {
    success: (r) => `Cleared ${plural(r.cleared, "member")}.`,
  });

  const data = list.data;
  const currency = data?.currency;
  const moneyName = currency?.name ? currency.name[0].toUpperCase() + currency.name.slice(1) : "Currency";

  const columns: Column<EngagementLeaderboardEntry>[] = [
    {
      key: "pos",
      header: "#",
      width: "56px",
      render: (e) =>
        e.position <= 3 ? <span className={styles.medal}>{MEDALS[e.position - 1]}</span> : <span className={styles.position}>{e.position}</span>,
    },
    { key: "name", header: "Member", render: (e) => <strong>{e.name}</strong> },
    ...(tab === "levels"
      ? [
          { key: "level", header: "Level", align: "right" as const, width: "80px", render: (e: EngagementLeaderboardEntry) => e.level },
          {
            key: "xp",
            header: "XP",
            align: "right" as const,
            width: "120px",
            render: (e: EngagementLeaderboardEntry) => <span className={styles.number}>{e.xp.toLocaleString()}</span>,
          },
        ]
      : [
          {
            key: "balance",
            header: "Balance",
            align: "right" as const,
            width: "180px",
            render: (e: EngagementLeaderboardEntry) => <span className={styles.number}>{formatMoney(currency, e.balance)}</span>,
          },
        ]),
  ];

  const settingsPage = tab === "money" ? "economy" : "levels";

  return (
    <>
      <PageHeader
        title="Leaderboard"
        description={
          <>
            Top members by level and by {currency?.name ?? "currency"}. Type <span className="tp-mono">{session.prefix}rank</span> or{" "}
            <span className="tp-mono">{session.prefix}balance</span> in chat to see where you stand.
          </>
        }
        actions={
          isAdmin && data && data.total > 0 ? (
            <Button variant="danger" icon="trash" onClick={() => setResetting(true)}>
              Reset {tab === "money" ? "balances" : "XP"}
            </Button>
          ) : undefined
        }
      />
      <Stack gap={12}>
        <Tabs<BoardKey>
          tabs={[
            { key: "levels", label: "Levels" },
            { key: "money", label: moneyName },
          ]}
          value={tab}
          onChange={(key) => {
            setTab(key);
            setPage(1);
          }}
        />
        {data && !data.enabled && (
          <Banner tone="info" title={tab === "money" ? "The economy is off" : "Levels are off"}>
            {isAdmin ? (
              <>
                Turn {tab === "money" ? "it" : "them"} on in <NavLink to={settingsPage}>Settings › {tab === "money" ? "Economy" : "Levels"}</NavLink>.
              </>
            ) : (
              "The standings below are frozen until the admins turn this back on."
            )}
          </Banner>
        )}
        {list.error && !data ? (
          <Card>
            <ErrorState message={list.error} onRetry={() => void list.reload()} />
          </Card>
        ) : (
          <Card padded={false}>
            <Table
              columns={columns}
              rows={data?.entries ?? []}
              rowKey={(e) => e.userId}
              onRowClick={isAdmin ? (e) => setAdjusting(e) : undefined}
              loading={list.loading}
              empty={
                <EmptyState
                  icon={<Icon name={tab === "money" ? "coins" : "trophy"} size={28} />}
                  title={tab === "money" ? "Nobody has any money yet" : "Nobody has earned XP yet"}
                  description={
                    tab === "money"
                      ? `Members earn with ${session.prefix}daily and ${session.prefix}work.`
                      : "Members earn XP by chatting, once a minute."
                  }
                />
              }
            />
            {data && data.pages > 1 && (
              <div className={styles.pager}>
                <span>
                  Page {data.page} of {data.pages} · {plural(data.total, "member")}
                </span>
                <div className={styles.pagerButtons}>
                  <Button size="sm" icon="chevronLeft" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <Button size="sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}
        {isAdmin && data && data.entries.length > 0 && <p className={styles.muted}>Click a member to adjust their {tab === "money" ? "balance" : "XP"}.</p>}
      </Stack>

      {adjusting && (
        <AdjustDialog
          entry={adjusting}
          board={board}
          onClose={() => setAdjusting(undefined)}
          onDone={() => {
            setAdjusting(undefined);
            void list.reload();
          }}
        />
      )}

      <ConfirmDialog
        open={resetting}
        title={tab === "money" ? "Reset every balance?" : "Reset everyone's XP?"}
        message={
          tab === "money"
            ? "Every balance, daily streak and cooldown goes back to zero. This can't be undone."
            : "Everyone goes back to level 0. Reward roles already given stay. This can't be undone."
        }
        confirmLabel="Reset"
        danger
        busy={reset.busy}
        onCancel={() => setResetting(false)}
        onConfirm={async () => {
          await reset.run();
          setResetting(false);
          void list.reload();
        }}
      />
    </>
  );
};

type Op = "give" | "take" | "set" | "reset";

const AdjustDialog: React.FC<{
  entry: EngagementLeaderboardEntry;
  board: EngagementBoard;
  onClose: () => void;
  onDone: (stats: EngagementMemberStats) => void;
}> = ({ entry, board, onClose, onDone }) => {
  const money = board === EngagementBoard.MONEY;
  const [op, setOp] = useState<Op>("give");
  const [amount, setAmount] = useState(100);
  const what = money ? "balance" : "XP";
  const adjust = useAction(
    () => engagementServiceClient.adjust({ userId: entry.userId, board, op, amount: op === "reset" ? 0 : amount }),
    {
      success: (s) => `${s.name}: ${money ? s.balance.toLocaleString() : `${s.xp.toLocaleString()} XP (level ${s.level})`}`,
      toastError: false,
    },
  );
  const min = op === "set" ? 0 : 1;
  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!adjust.busy}
      title={`Adjust ${entry.name}'s ${what}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={adjust.busy}>
            Cancel
          </Button>
          <Button
            variant={op === "reset" ? "danger" : "primary"}
            loading={adjust.busy}
            onClick={async () => {
              const result = await adjust.run();
              if (result) onDone(result);
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <Stack gap={14}>
        <p className={styles.sub}>
          Currently {money ? entry.balance.toLocaleString() : `${entry.xp.toLocaleString()} XP (level ${entry.level})`}.
          {!money && " Reward roles follow the new level."}
        </p>
        <Field label="Action">
          <Select<Op>
            value={op}
            onChange={setOp}
            options={[
              { value: "give", label: `Give ${what}` },
              { value: "take", label: `Take ${what}` },
              { value: "set", label: `Set ${what} to` },
              { value: "reset", label: `Reset to 0` },
            ]}
          />
        </Field>
        {op !== "reset" && (
          <Field label="Amount">
            <NumberInput value={amount} onChange={setAmount} min={min} max={1_000_000_000} width={160} suffix={money ? undefined : "XP"} />
          </Field>
        )}
        {adjust.error && <Banner tone="error">{adjust.error}</Banner>}
      </Stack>
    </Modal>
  );
};

export default Leaderboard;
