import React, { useEffect, useState } from "react";
import type { EngagementMe, EngagementShopItem } from "@taproot/gen-shared";
import { engagementServiceClient } from "@taproot/gen-client";
import { Button, Card, ConfirmDialog, ErrorState, Row, Spinner, Stack } from "../../components";
import { formatDuration, NavLink, useAction, useRpc, useSession } from "../../lib";
import { AREA, formatMoney, ProgressBar, useEngagementChanged } from "./shared";
import styles from "./engagement.module.css";

// Cards on every member's Me page: level progress, and the wallet with
// daily/work buttons and the shop. Hidden while the feature is off.

/** Re-renders every 30s so cooldowns count down. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const MeSection: React.FC = () => {
  const me = useRpc(() => engagementServiceClient.getMe());
  useEngagementChanged([AREA.xp, AREA.money, AREA.config], () => void me.reload());

  if (me.error && !me.data) {
    return (
      <Card title="Level and wallet">
        <ErrorState compact message={me.error} onRetry={() => void me.reload()} />
      </Card>
    );
  }
  if (!me.data) return null;
  const data = me.data;
  return (
    <>
      {data.levelsEnabled && <LevelCard me={data} />}
      {data.economyEnabled && <WalletCard me={data} onChange={me.setData} />}
    </>
  );
};

const LevelCard: React.FC<{ me: EngagementMe }> = ({ me }) => {
  const { session } = useSession();
  return (
    <Card
      title="Level"
      description={`You earn XP by chatting. Type ${session.prefix}rank in chat to show it off.`}
      actions={<NavLink to="leaderboard">Leaderboard</NavLink>}
    >
      <Stack gap={8}>
        <Row justify="between" align="baseline" wrap>
          <span className={styles.big}>Level {me.level}</span>
          <span className={styles.sub}>{me.xpRank ? `Rank #${me.xpRank}` : "Not ranked yet"}</span>
        </Row>
        <div>
          <ProgressBar value={me.levelXp} max={me.levelXpNeeded} label={`Progress to level ${me.level + 1}`} />
          <div className={styles.progressText}>
            <span>
              {me.levelXp.toLocaleString()} / {me.levelXpNeeded.toLocaleString()} XP to level {me.level + 1}
            </span>
            <span>{me.xp.toLocaleString()} XP total</span>
          </div>
        </div>
      </Stack>
    </Card>
  );
};

const WalletCard: React.FC<{ me: EngagementMe; onChange: (me: EngagementMe) => void }> = ({ me, onChange }) => {
  const now = useNow();
  const currency = me.currency;
  const daily = useAction(() => engagementServiceClient.claimDaily(), {
    success: (r) => `You collected ${formatMoney(currency, r.amount)}.`,
  });
  const work = useAction(() => engagementServiceClient.work(), {
    success: (r) => `You worked and earned ${formatMoney(currency, r.amount)}.`,
  });
  const dailyWait = me.nextDailyAtMs > now ? me.nextDailyAtMs - now : 0;
  const workWait = me.nextWorkAtMs > now ? me.nextWorkAtMs - now : 0;
  const wait = (ms: number) => formatDuration(Math.max(60_000, ms), 1);

  return (
    <Card title="Wallet" actions={<NavLink to="leaderboard">Leaderboard</NavLink>}>
      <Stack gap={14}>
        <Row justify="between" align="baseline" wrap>
          <span className={styles.big}>{formatMoney(currency, me.balance)}</span>
          <span className={styles.sub}>
            {me.moneyRank ? `Rank #${me.moneyRank}` : "Not ranked yet"}
            {me.dailyStreak > 1 && ` · 🔥 ${me.dailyStreak}-day streak`}
          </span>
        </Row>
        <div className={styles.actions}>
          <Button
            variant="primary"
            icon="gift"
            loading={daily.busy}
            disabled={dailyWait > 0}
            onClick={async () => {
              const r = await daily.run();
              if (r?.me) onChange(r.me);
            }}
          >
            {dailyWait > 0 ? `Daily in ${wait(dailyWait)}` : "Collect daily"}
          </Button>
          <Button
            icon="zap"
            loading={work.busy}
            disabled={workWait > 0}
            onClick={async () => {
              const r = await work.run();
              if (r?.me) onChange(r.me);
            }}
          >
            {workWait > 0 ? `Work in ${wait(workWait)}` : "Work"}
          </Button>
        </div>
        <Shop me={me} onChange={onChange} />
      </Stack>
    </Card>
  );
};

const Shop: React.FC<{ me: EngagementMe; onChange: (me: EngagementMe) => void }> = ({ me, onChange }) => {
  const list = useRpc(() => engagementServiceClient.listShop());
  useEngagementChanged([AREA.shop], () => void list.reload());
  const [buying, setBuying] = useState<EngagementShopItem | undefined>(undefined);
  const buy = useAction((id: number) => engagementServiceClient.buy({ id }), {
    success: () => `You bought ${buying?.name ?? "the item"}.`,
  });

  if (list.error && !list.data) return <ErrorState compact message={list.error} onRetry={() => void list.reload()} />;
  if (!list.data) return <Spinner block />;
  const items = list.data.items.filter((i) => i.roleName);
  if (items.length === 0) return null;

  return (
    <div>
      <div className={styles.shopMeta} style={{ marginBottom: 4 }}>
        SHOP
      </div>
      {items.map((item) => {
        const soldOut = item.limited && item.stock <= 0;
        return (
          <div key={item.id} className={styles.shopRow} style={{ paddingLeft: 0, paddingRight: 0 }}>
            <div className={styles.shopMain}>
              <div className={styles.shopName}>{item.name}</div>
              <div className={styles.shopMeta}>
                Role {item.roleName}
                {item.limited && ` · ${soldOut ? "sold out" : `${item.stock} left`}`}
                {item.description && ` · ${item.description}`}
              </div>
            </div>
            <Button size="sm" disabled={soldOut || me.balance < item.price} onClick={() => setBuying(item)}>
              {formatMoney(me.currency, item.price)}
            </Button>
          </div>
        );
      })}
      <ConfirmDialog
        open={!!buying}
        title={`Buy ${buying?.name ?? ""}?`}
        message={buying && `You'll pay ${formatMoney(me.currency, buying.price)} and get the ${buying.roleName} role.`}
        confirmLabel="Buy"
        busy={buy.busy}
        onCancel={() => setBuying(undefined)}
        onConfirm={async () => {
          if (!buying) return;
          const result = await buy.run(buying.id);
          if (result) onChange(result);
          setBuying(undefined);
          void list.reload();
        }}
      />
    </div>
  );
};

export default MeSection;
