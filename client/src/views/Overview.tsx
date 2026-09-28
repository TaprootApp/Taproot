import React, { useState } from "react";
import { moderationServiceClient, ModerationServiceClientEvent } from "@taproot/gen-client";
import { ActiveMute, BanInfo, CaseAction } from "@taproot/gen-shared";
import {
  Button,
  Card,
  Column,
  EmptyState,
  ErrorState,
  Grid,
  PageHeader,
  Stack,
  Stat,
  Table,
} from "../components";
import { formatDateTime, formatRelative, useBroadcast, useNav, useRpc } from "../lib";
import { CaseTable } from "./moderation/CaseTable";
import { MemberLink } from "./moderation/MemberLink";
import { ModActionDialog, ModActionKind, ModTarget } from "./moderation/ModActionDialog";

// Staff dashboard: headline numbers, the latest cases, and who is muted or
// banned right now. Everything refetches when a case is created or changed.

const Overview: React.FC = () => {
  const { navigate } = useNav();
  const stats = useRpc(() => moderationServiceClient.getStats());
  const recent = useRpc(() => moderationServiceClient.listCases({ action: CaseAction.UNSPECIFIED, beforeId: 0, limit: 10 }));
  const mutes = useRpc(async () => (await moderationServiceClient.listActiveMutes()).mutes);
  const bans = useRpc(async () => (await moderationServiceClient.listBans()).bans);
  const [pending, setPending] = useState<{ kind: ModActionKind; target: ModTarget } | undefined>();

  const reloadAll = () => {
    void stats.reload();
    void recent.reload();
    void mutes.reload();
    void bans.reload();
  };
  useBroadcast(moderationServiceClient, ModerationServiceClientEvent.CasesChanged, reloadAll, { filter: (event) => event.area !== "punishments" });

  const muteColumns: Column<ActiveMute>[] = [
    { key: "member", header: "Member", render: (m) => <MemberLink userId={m.userId} name={m.nickname} /> },
    {
      key: "expires",
      header: "Ends",
      render: (m) =>
        m.expiresAtMs ? (
          <span title={formatDateTime(m.expiresAtMs)}>{formatRelative(m.expiresAtMs)}</span>
        ) : (
          <span className="tp-muted">Indefinite</span>
        ),
    },
    {
      key: "case",
      header: "Case",
      hideOnMobile: true,
      render: (m) => (m.caseId ? <span className="tp-mono">#{m.caseId}</span> : <span className="tp-subtle">—</span>),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (m) => (
        <Button size="sm" onClick={() => setPending({ kind: "unmute", target: m })}>
          Unmute
        </Button>
      ),
    },
  ];

  const banColumns: Column<BanInfo>[] = [
    { key: "member", header: "Member", render: (b) => <MemberLink userId={b.userId} name={b.nickname} /> },
    {
      key: "reason",
      header: "Reason",
      wrap: true,
      hideOnMobile: true,
      render: (b) => b.reason || <span className="tp-subtle">No reason given</span>,
    },
    {
      key: "expires",
      header: "Ends",
      render: (b) =>
        b.expiresAtMs ? (
          <span title={formatDateTime(b.expiresAtMs)}>{formatRelative(b.expiresAtMs)}</span>
        ) : (
          <span className="tp-muted">Permanent</span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (b) => (
        <Button size="sm" onClick={() => setPending({ kind: "unban", target: b })}>
          Unban
        </Button>
      ),
    },
  ];

  const s = stats.data;
  const statValue = (n: number | undefined) => (n === undefined ? "–" : n.toLocaleString());

  return (
    <>
      <PageHeader
        title="Overview"
        description="What's happening in moderation. Updates live as cases come in."
        actions={
          <Button icon="refresh" onClick={reloadAll} loading={stats.loading && !!s}>
            Refresh
          </Button>
        }
      />
      <Stack>
        {stats.error && !s ? (
          <Card>
            <ErrorState message={stats.error} onRetry={() => void stats.reload()} compact />
          </Card>
        ) : (
          <Grid min={150}>
            <Stat
              label="Cases, 24 hours"
              value={statValue(s?.casesLast24H)}
              onClick={() => navigate("cases")}
            />
            <Stat label="Cases, 7 days" value={statValue(s?.casesLast7D)} onClick={() => navigate("cases")} />
            <Stat
              label="Auto-mod, 24 hours"
              value={statValue(s?.automodLast24H)}
              tone="brand"
              onClick={() => navigate("cases", { action: String(CaseAction.AUTOMOD) })}
            />
            <Stat label="Active mutes" value={statValue(s?.activeMutes)} tone={s?.activeMutes ? "warning" : "neutral"} />
            <Stat label="Active bans" value={statValue(s?.activeBans)} tone={s?.activeBans ? "danger" : "neutral"} />
          </Grid>
        )}

        <Card
          title="Latest cases"
          padded={false}
          actions={
            <Button size="sm" onClick={() => navigate("cases")}>
              View all
            </Button>
          }
        >
          {recent.error && !recent.data ? (
            <ErrorState message={recent.error} onRetry={() => void recent.reload()} compact />
          ) : (
            <CaseTable
              cases={recent.data?.cases ?? []}
              loading={recent.loading}
              empty={<EmptyState compact icon="📋" title="No cases yet" description="Warnings, mutes, kicks and bans show up here." />}
            />
          )}
        </Card>

        <Grid min={340} gap={16}>
          <Card title="Muted now" padded={false}>
            {mutes.error && !mutes.data ? (
              <ErrorState message={mutes.error} onRetry={() => void mutes.reload()} compact />
            ) : (
              <Table
                columns={muteColumns}
                rows={mutes.data ?? []}
                rowKey={(m) => m.userId}
                loading={mutes.loading}
                empty={<EmptyState compact icon="🔈" title="Nobody is muted" />}
              />
            )}
          </Card>
          <Card title="Banned" padded={false}>
            {bans.error && !bans.data ? (
              <ErrorState message={bans.error} onRetry={() => void bans.reload()} compact />
            ) : (
              <Table
                columns={banColumns}
                rows={bans.data ?? []}
                rowKey={(b) => b.userId}
                loading={bans.loading}
                empty={<EmptyState compact icon="🚪" title="Nobody is banned" />}
              />
            )}
          </Card>
        </Grid>
      </Stack>

      <ModActionDialog
        kind={pending?.kind}
        target={pending?.target}
        onClose={() => setPending(undefined)}
        onDone={reloadAll}
      />
    </>
  );
};

export default Overview;
