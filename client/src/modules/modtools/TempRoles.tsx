import React, { useState } from "react";
import { modtoolsServiceClient } from "@taproot/gen-client";
import type { ModtoolsTempRole } from "@taproot/gen-shared";
import { Badge, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, PageHeader, Table } from "../../components";
import type { Column } from "../../components";
import { formatDateTime, formatRelative, useAction, useNav, useRpc, useSession } from "../../lib";
import { useModtoolsChanged } from "./shared";

// Every active temp role (moderator+). Give new ones from a member's page or
// with "temprole @member @role 3d".

const TempRoles: React.FC = () => {
  const { session } = useSession();
  const { navigate } = useNav();
  const list = useRpc(() => modtoolsServiceClient.listTempRoles());
  useModtoolsChanged(["temproles"], () => void list.reload());
  const [ending, setEnding] = useState<ModtoolsTempRole | undefined>();
  const end = useAction((id: number) => modtoolsServiceClient.removeTempRole({ id }), { success: (r) => r.message });

  const columns: Column<ModtoolsTempRole>[] = [
    { key: "member", header: "Member", render: (r) => r.userName || r.userId },
    { key: "role", header: "Role", render: (r) => <Badge>{r.roleName || "Deleted role"}</Badge> },
    {
      key: "ends",
      header: "Ends",
      render: (r) => <span title={formatDateTime(r.expiresAtMs)}>{formatRelative(r.expiresAtMs)}</span>,
    },
    { key: "by", header: "Given by", hideOnMobile: true, render: (r) => r.addedByName || "Unknown" },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "56px",
      render: (r) => (
        <span onClick={(e) => e.stopPropagation()}>
          <IconButton icon="close" label={`Take ${r.roleName} back now`} danger onClick={() => setEnding(r)} />
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Temp roles"
        description={
          <>
            Roles Taproot takes away again automatically. Give one from a member's page or with{" "}
            <span className="tp-mono">{session.prefix}temprole @member @role 3d</span>.
          </>
        }
      />
      <Card padded={false}>
        {list.error && !list.data ? (
          <ErrorState message={list.error} onRetry={() => void list.reload()} />
        ) : (
          <Table
            columns={columns}
            rows={list.data?.tempRoles ?? []}
            rowKey={(r) => r.id}
            loading={!list.data}
            onRowClick={(r) => navigate("members", { userId: r.userId, name: r.userName })}
            empty={<EmptyState compact icon="⏳" title="No temp roles" description="Nobody has a temporary role right now." />}
          />
        )}
      </Card>
      <ConfirmDialog
        open={!!ending}
        title={`Take ${ending?.roleName || "the role"} back?`}
        message={`${ending?.userName || "The member"} loses the role now instead of when it runs out.`}
        confirmLabel="Take back"
        danger
        busy={end.busy}
        onCancel={() => setEnding(undefined)}
        onConfirm={async () => {
          if (ending && (await end.run(ending.id))) void list.reload();
          setEnding(undefined);
        }}
      />
    </>
  );
};

export default TempRoles;
