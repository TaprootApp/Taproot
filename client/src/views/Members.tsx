import React, { useEffect, useState } from "react";
import { RootGuidType, RootGuidUtils } from "@rootsdk/client-app";
import { moderationServiceClient, ModerationServiceClientEvent } from "@taproot/gen-client";
import { CaseAction, MemberDetail, StaffLevel } from "@taproot/gen-shared";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Row,
  Section,
  Spinner,
  Stack,
  TextInput,
} from "../components";
import {
  cx,
  formatDate,
  formatDateTime,
  formatRelative,
  plural,
  STAFF_LEVEL_LABEL,
  useBroadcast,
  useNav,
  useRpc,
  useSession,
} from "../lib";
import { DurationDialog } from "../modules/modtools/DurationDialog";
import { MemberCards } from "../modules/modtools/MemberCards";
import { CaseTable } from "./moderation/CaseTable";
import { initial } from "./moderation/MemberLink";
import { MemberRow, useMemberSearch } from "./moderation/memberSearch";
import { ModActionDialog, ModActionKind } from "./moderation/ModActionDialog";
import styles from "./moderation/moderation.module.css";

// Look up a member and act on them. Search on the left, detail on the
// right (stacked on phones). Other screens deep-link here with nav params
// { userId, name }.

const Members: React.FC = () => {
  const { params } = useNav();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | undefined>(params.userId);
  const search = useMemberSearch(query);

  // Follow later navigations here (e.g. a member link on this page).
  useEffect(() => {
    if (params.userId) setSelected(params.userId);
  }, [params]);

  const results = search.term ? search.data ?? [] : [];
  const pending = query.trim() !== search.term || search.loading;

  return (
    <>
      <PageHeader title="Members" description="Find a member to see their history and take action." />
      <div className={styles.membersLayout}>
        <Card>
          <TextInput
            value={query}
            onChange={setQuery}
            placeholder="Search by name or user ID"
            type="search"
            aria-label="Search members"
            autoComplete="off"
            autoFocus={!params.userId}
            onEnter={() => results[0] && setSelected(results[0].userId)}
          />
          <div className={styles.resultList}>
            {query.trim() === "" ? (
              <p className="tp-subtle">Type part of a nickname, or paste a user ID to find someone who left.</p>
            ) : search.error && !pending ? (
              <p className="tp-muted">{search.error}</p>
            ) : results.length === 0 ? (
              pending ? <Spinner size={16} label="Searching…" /> : <p className="tp-muted">No members match.</p>
            ) : (
              results.map((m) => (
                <MemberRow
                  key={m.userId}
                  member={m}
                  active={m.userId === selected}
                  onClick={() => setSelected(m.userId)}
                />
              ))
            )}
          </div>
        </Card>

        {selected ? (
          <MemberPanel key={selected} userId={selected} fallbackName={params.userId === selected ? params.name : undefined} />
        ) : (
          <Card>
            <EmptyState icon="👤" title="No member selected" description="Search for someone to see their details." />
          </Card>
        )}
      </div>
    </>
  );
};

const MemberPanel: React.FC<{ userId: string; fallbackName?: string }> = ({ userId, fallbackName }) => {
  const { session, level: myLevel } = useSession();
  const { navigate } = useNav();
  const detail = useRpc(() => moderationServiceClient.getMember({ userId }), [userId]);
  const [kind, setKind] = useState<ModActionKind | undefined>();
  const [changing, setChanging] = useState<"mute" | "ban" | undefined>();

  useBroadcast(moderationServiceClient, ModerationServiceClientEvent.CasesChanged, () => void detail.reload(), { filter: (event) => event.area !== "punishments" });

  const m = detail.data;
  if (!m) {
    return (
      <Card>
        {detail.error ? (
          <ErrorState message={detail.error} onRetry={() => void detail.reload()} compact />
        ) : (
          <Spinner block label={fallbackName ? `Loading ${fallbackName}…` : "Loading member…"} />
        )}
      </Card>
    );
  }

  const isSelf = m.userId === session.userId;
  const isApp = isAppId(m.userId);
  const outranks = m.level >= myLevel;
  const canAct = !isSelf && !isApp && !outranks;
  const name = m.nickname || fallbackName || "Unknown member";

  return (
    <Stack>
      <Card
        actions={
          <Button size="sm" icon="refresh" onClick={() => void detail.reload()} loading={detail.loading}>
            Refresh
          </Button>
        }
        title={
          <span className={styles.detailHead}>
            <span className={cx(styles.avatar, styles.avatarLarge)} aria-hidden>
              {initial(name)}
            </span>
            <span>
              <span className={styles.detailName}>{name}</span>
              <br />
              <span className="tp-mono tp-subtle">{m.userId}</span>
            </span>
          </span>
        }
      >
        <Stack>
          <StateBanners member={m} onChangeLength={canAct ? setChanging : undefined} />

          <div className={styles.facts}>
            <Fact label="Joined">
              {m.inCommunity && m.joinedAtMs ? (
                <span title={formatDateTime(m.joinedAtMs)}>
                  {formatDate(m.joinedAtMs)} <span className="tp-subtle">({formatRelative(m.joinedAtMs)})</span>
                </span>
              ) : (
                <span className="tp-muted">{m.inCommunity ? "Unknown" : "Not in the community"}</span>
              )}
            </Fact>
            <Fact label="Staff level">
              {m.level > StaffLevel.MEMBER ? (
                <Badge tone="brand">{STAFF_LEVEL_LABEL[m.level]}</Badge>
              ) : (
                STAFF_LEVEL_LABEL[m.level]
              )}
            </Fact>
            <Fact label="Warnings">
              {m.activeWarnings > 0 ? (
                <Badge tone="warning">{plural(m.activeWarnings, "active warning")}</Badge>
              ) : (
                <span className="tp-muted">None</span>
              )}
            </Fact>
            <Fact label="Status">
              <StatusBadges member={m} />
            </Fact>
          </div>

          {m.inCommunity && (
            <Section title="Roles">
              {m.roles.length > 0 ? (
                <div className={styles.badges}>
                  {m.roles.map((r) => (
                    <Badge key={r.id} color={r.colorHex || undefined} title={r.privileged ? "Staff permissions" : undefined}>
                      {r.name}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="tp-muted">No roles.</p>
              )}
            </Section>
          )}

          <Section title="Actions">
            {isSelf ? (
              <p className="tp-muted">This is you. Moderation actions aren't available on your own account.</p>
            ) : isApp ? (
              <p className="tp-muted">This is a bot or app. Bots and apps can't be moderated.</p>
            ) : !canAct ? (
              <p className="tp-muted">
                {name} is {m.level === StaffLevel.OWNER ? "the owner" : `ranked ${STAFF_LEVEL_LABEL[m.level]}`}, at or
                above your level, so you can't act on them here.
              </p>
            ) : (
              <Row>
                {m.inCommunity && (
                  <Button icon="alert" onClick={() => setKind("warn")}>
                    Warn
                  </Button>
                )}
                {m.muted ? (
                  <Button icon="mute" onClick={() => setKind("unmute")}>
                    Unmute
                  </Button>
                ) : (
                  m.inCommunity && (
                    <Button icon="mute" onClick={() => setKind("mute")}>
                      Mute
                    </Button>
                  )
                )}
                {m.inCommunity && (
                  <Button icon="wave" variant="danger" onClick={() => setKind("kick")}>
                    Kick
                  </Button>
                )}
                {m.banned ? (
                  <Button icon="ban" onClick={() => setKind("unban")}>
                    Unban
                  </Button>
                ) : (
                  <Button icon="ban" variant="danger" onClick={() => setKind("ban")}>
                    Ban
                  </Button>
                )}
              </Row>
            )}
          </Section>
        </Stack>
      </Card>

      <MemberCards userId={m.userId} name={name} canAct={canAct} inCommunity={m.inCommunity} />

      <Card
        title="Recent cases"
        description={m.recentCases.length >= 20 ? "The 20 newest." : undefined}
        padded={false}
        actions={
          <Button size="sm" onClick={() => navigate("cases", { userId: m.userId, name })}>
            All cases
          </Button>
        }
      >
        <CaseTable
          cases={m.recentCases}
          hideMember
          actions
          onCaseChanged={() => void detail.reload()}
          empty={<EmptyState compact icon="✨" title="Clean record" description={`${name} has no cases.`} />}
        />
      </Card>

      <ModActionDialog
        kind={kind}
        target={{ userId: m.userId, nickname: name }}
        onClose={() => setKind(undefined)}
        onDone={() => void detail.reload()}
      />
      <DurationDialog
        caseId={changing ? latestCaseId(m, changing) : undefined}
        kind={changing ?? "mute"}
        name={name}
        onClose={() => setChanging(undefined)}
        onDone={() => void detail.reload()}
      />
    </Stack>
  );
};

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <span className={styles.factLabel}>{label}</span>
    <span className={styles.factValue}>{children}</span>
  </div>
);

const StatusBadges: React.FC<{ member: MemberDetail }> = ({ member: m }) => {
  if (!m.muted && !m.banned) return <span className="tp-muted">{m.inCommunity ? "In good standing" : "Left"}</span>;
  return (
    <span className={styles.badges}>
      {m.muted && <Badge tone="warning">Muted</Badge>}
      {m.banned && <Badge tone="danger">Banned</Badge>}
    </span>
  );
};

/** The newest mute or ban case: the one "duration" changes. */
function latestCaseId(m: MemberDetail, kind: "mute" | "ban"): number | undefined {
  const action = kind === "mute" ? CaseAction.MUTE : CaseAction.BAN;
  return m.recentCases.find((c) => c.action === action)?.id;
}

const StateBanners: React.FC<{ member: MemberDetail; onChangeLength?: (kind: "mute" | "ban") => void }> = ({
  member: m,
  onChangeLength,
}) => {
  const changeButton = (kind: "mute" | "ban") =>
    onChangeLength && latestCaseId(m, kind) !== undefined ? (
      <Button size="sm" icon="clock" onClick={() => onChangeLength(kind)}>
        Change length
      </Button>
    ) : undefined;
  return (
    <>
      {m.muted && (
        <Banner tone="warning" title="Muted" action={changeButton("mute")}>
          {m.muteExpiresAtMs
            ? `Until ${formatDateTime(m.muteExpiresAtMs)} (${formatRelative(m.muteExpiresAtMs)}).`
            : "Indefinitely, until a moderator unmutes them."}
        </Banner>
      )}
      {m.banned && (
        <Banner tone="error" title="Banned" action={changeButton("ban")}>
          They can't rejoin until they're unbanned.
        </Banner>
      )}
      {!m.inCommunity && !m.banned && (
        <Banner tone="info" title="Not in the community">
          They've left. Details come from the last name Taproot saw.
        </Banner>
      )}
    </>
  );
};

/** Bots and apps have App-typed IDs; the server refuses to moderate them. */
function isAppId(userId: string): boolean {
  try {
    return RootGuidUtils.toRootGuidType(userId) === RootGuidType.App;
  } catch {
    return false;
  }
}

export default Members;
