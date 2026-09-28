import React, { useCallback, useEffect, useRef, useState } from "react";
import { moderationServiceClient, ModerationServiceClientEvent } from "@taproot/gen-client";
import { CaseAction, ModCase } from "@taproot/gen-shared";
import { Button, Card, Chip, EmptyState, ErrorState, Field, PageHeader, Select, SelectOption } from "../components";
import { CASE_ACTION_LABEL, errorMessage, plural, useBroadcast, useNav } from "../lib";
import { CaseTable } from "./moderation/CaseTable";
import { MemberPicker } from "./moderation/memberSearch";
import styles from "./moderation/moderation.module.css";

// The full case log: filter by action and member, page back with "Load
// more", edit reasons and void warnings. Opened with nav params
// { userId, name } or { action } to start filtered.

const PAGE = 25;
const MAX_LIMIT = 100;

const ACTION_OPTIONS: SelectOption<CaseAction>[] = [
  { value: CaseAction.UNSPECIFIED, label: "All actions" },
  ...[
    CaseAction.WARN,
    CaseAction.MUTE,
    CaseAction.UNMUTE,
    CaseAction.KICK,
    CaseAction.BAN,
    CaseAction.UNBAN,
    CaseAction.AUTOMOD,
    CaseAction.PURGE,
    CaseAction.LOCK,
    CaseAction.UNLOCK,
  ].map((a) => ({ value: a, label: CASE_ACTION_LABEL[a] })),
];

function actionFromParam(value: string | undefined): CaseAction {
  const n = Number(value);
  return value && Number.isInteger(n) && CASE_ACTION_LABEL[n as CaseAction] !== undefined
    ? (n as CaseAction)
    : CaseAction.UNSPECIFIED;
}

const Cases: React.FC = () => {
  const { params } = useNav();
  const [action, setAction] = useState<CaseAction>(() => actionFromParam(params.action));
  const [member, setMember] = useState<{ userId: string; nickname: string } | undefined>(() =>
    params.userId ? { userId: params.userId, nickname: params.name ?? params.userId } : undefined,
  );

  // Follow later navigations to this page with new params.
  useEffect(() => {
    setAction(actionFromParam(params.action));
    setMember(params.userId ? { userId: params.userId, nickname: params.name ?? params.userId } : undefined);
  }, [params]);

  const [cases, setCases] = useState<ModCase[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const requestId = useRef(0);
  const loadedCount = useRef(0);
  loadedCount.current = cases.length;

  const filter = { userId: member?.userId, action };
  const filterRef = useRef(filter);
  filterRef.current = filter;

  /** Loads the newest page; `keep` refetches as many rows as are showing (for live updates). */
  const loadFirst = useCallback(async (keep: boolean) => {
    const id = ++requestId.current;
    const limit = keep ? Math.min(MAX_LIMIT, Math.max(PAGE, loadedCount.current)) : PAGE;
    setLoading(true);
    try {
      const page = await moderationServiceClient.listCases({ ...filterRef.current, beforeId: 0, limit });
      if (id !== requestId.current) return;
      setCases(page.cases);
      setHasMore(page.hasMore);
      setError(undefined);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(errorMessage(err));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setCases([]);
    void loadFirst(false);
  }, [loadFirst, member?.userId, action]);

  useEffect(
    () => () => {
      // Drop responses that land after unmount.
      requestId.current++;
    },
    [],
  );

  useBroadcast(moderationServiceClient, ModerationServiceClientEvent.CasesChanged, () => void loadFirst(true), { filter: (event) => event.area !== "punishments" });

  const loadMore = async () => {
    const last = cases[cases.length - 1];
    if (!last) return;
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const page = await moderationServiceClient.listCases({ ...filterRef.current, beforeId: last.id, limit: PAGE });
      // A filter change or live refresh started meanwhile: its result wins.
      if (id !== requestId.current) return;
      setCases((prev) => [...prev, ...page.cases.filter((c) => !prev.some((p) => p.id === c.id))]);
      setHasMore(page.hasMore);
    } catch (err) {
      if (id === requestId.current) setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const replaceCase = (updated: ModCase) => setCases((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  const filtered = !!member || action !== CaseAction.UNSPECIFIED;

  return (
    <>
      <PageHeader
        title="Cases"
        description="Every moderation action, newest first. Voided warnings are struck through."
        actions={
          <Button icon="refresh" onClick={() => void loadFirst(true)} loading={loading && cases.length > 0}>
            Refresh
          </Button>
        }
      />

      <div className={styles.filters}>
        <div className={styles.filterAction}>
          <Field label="Action">
            <Select value={action} onChange={setAction} options={ACTION_OPTIONS} />
          </Field>
        </div>
        <div className={styles.filterMember}>
          <Field label="Member">
            {member ? (
              <div>
                <Chip label={member.nickname || member.userId} onRemove={() => setMember(undefined)} />
              </div>
            ) : (
              <MemberPicker onPick={(m) => setMember({ userId: m.userId, nickname: m.nickname })} />
            )}
          </Field>
        </div>
        {filtered && (
          <Button
            variant="quiet"
            onClick={() => {
              setAction(CaseAction.UNSPECIFIED);
              setMember(undefined);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      <Card
        padded={false}
        title={cases.length > 0 ? `${plural(cases.length, "case")}${hasMore ? " so far" : ""}` : undefined}
      >
        {error && cases.length === 0 ? (
          <ErrorState message={error} onRetry={() => void loadFirst(false)} compact />
        ) : (
          <>
            <CaseTable
              cases={cases}
              loading={loading}
              actions
              onCaseChanged={replaceCase}
              empty={
                <EmptyState
                  compact
                  icon="📋"
                  title={filtered ? "No matching cases" : "No cases yet"}
                  description={
                    filtered
                      ? "Try another action or member."
                      : "Warnings, mutes, kicks, bans and auto-mod actions are logged here."
                  }
                />
              }
            />
            {hasMore && cases.length > 0 && (
              <div className={styles.loadMore}>
                <Button onClick={() => void loadMore()} loading={loadingMore}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
};

export default Cases;
