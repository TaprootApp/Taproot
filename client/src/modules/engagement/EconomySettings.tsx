import React, { useState } from "react";
import type { EngagementEconomySettings, EngagementShopItem } from "@taproot/gen-shared";
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
  IconButton,
  Modal,
  NumberInput,
  PageHeader,
  RoleSelect,
  Stack,
  Table,
  TextInput,
  Toggle,
} from "../../components";
import type { Column } from "../../components";
import { useAction, useRpc, useSession } from "../../lib";
import { AREA, DraftGate, DraftNotices, DraftSaveBar, formatMoney, useEngagementChanged, useSettingsDraft } from "./shared";
import styles from "./engagement.module.css";

// Economy settings and the role shop (admins). Same limits as
// validateEconomy and EngagementService.saveShopItem on the server.

const MAX_SHOP_ITEMS = 50;

function problems(s: EngagementEconomySettings): string | undefined {
  if (!s.currencyName.trim()) return "Name the currency.";
  if (s.workMin > s.workMax) return "Work pay: the minimum can't be above the maximum.";
  return undefined;
}

const EconomySettings: React.FC = () => {
  const { session } = useSession();
  const p = session.prefix;
  const form = useSettingsDraft("economy", (economy) => engagementServiceClient.saveEconomy(economy));

  return (
    <Stack>
      <PageHeader title="Economy" description="A community currency members earn and spend on roles." />
      <DraftGate form={form}>
        {(s) => {
          const patch = (change: Partial<EngagementEconomySettings>) => form.patch(change);
          const currency = { name: s.currencyName || "coins", symbol: s.currencySymbol };
          return (
            <>
              <DraftNotices form={form} />
              <Card>
                <Toggle
                  checked={s.enabled}
                  onChange={(enabled) => patch({ enabled })}
                  label="Economy"
                  description={`Members use ${p}daily, ${p}work, ${p}pay, ${p}balance, ${p}shop and ${p}buy.`}
                />
              </Card>

              <Card title="Currency">
                <div className={styles.editorRow}>
                  <Field label="Name" help="Plural, e.g. coins or gems.">
                    <TextInput value={s.currencyName} onChange={(currencyName) => patch({ currencyName })} maxLength={32} />
                  </Field>
                  <Field label="Symbol" help="An emoji or short text. Optional.">
                    <TextInput value={s.currencySymbol} onChange={(currencySymbol) => patch({ currencySymbol })} maxLength={32} />
                  </Field>
                </div>
                <p className={styles.muted} style={{ marginTop: 10 }}>
                  Shows as <strong>{formatMoney(currency, 1250)}</strong>.
                </p>
              </Card>

              <Card title="Earning" description={`${p}daily works every 20 hours; ${p}work every hour.`}>
                <Stack gap={12}>
                  <div className={styles.editorRow}>
                    <Field label="Daily reward">
                      <NumberInput value={s.dailyAmount} onChange={(dailyAmount) => patch({ dailyAmount })} min={1} max={1_000_000} width={110} />
                    </Field>
                    <Field label="Streak bonus per day">
                      <NumberInput
                        value={s.dailyStreakBonus}
                        onChange={(dailyStreakBonus) => patch({ dailyStreakBonus })}
                        min={0}
                        max={1_000_000}
                        width={110}
                      />
                    </Field>
                    <Field label="Bonus stops growing after">
                      <NumberInput value={s.dailyStreakCap} onChange={(dailyStreakCap) => patch({ dailyStreakCap })} min={1} max={365} suffix="days" />
                    </Field>
                  </div>
                  <p className={styles.muted}>
                    Day 1 pays {formatMoney(currency, s.dailyAmount)}; a {s.dailyStreakCap}-day streak pays{" "}
                    {formatMoney(currency, s.dailyAmount + s.dailyStreakBonus * (s.dailyStreakCap - 1))}. Missing more than 48
                    hours restarts the streak.
                  </p>
                  <div className={styles.editorRow}>
                    <Field label="Work pays at least">
                      <NumberInput value={s.workMin} onChange={(workMin) => patch({ workMin })} min={1} max={1_000_000} width={110} />
                    </Field>
                    <Field label="and at most">
                      <NumberInput value={s.workMax} onChange={(workMax) => patch({ workMax })} min={1} max={1_000_000} width={110} />
                    </Field>
                  </div>
                </Stack>
              </Card>
              {!s.enabled && <Banner tone="info">The economy is off. Balances are kept while it's off.</Banner>}
              <DraftSaveBar form={form} invalid={problems(s)} />
            </>
          );
        }}
      </DraftGate>
      <ShopEditor />
    </Stack>
  );
};

const ShopEditor: React.FC = () => {
  const { session } = useSession();
  const list = useRpc(() => engagementServiceClient.listShop());
  useEngagementChanged([AREA.shop, AREA.config], () => void list.reload());
  // undefined = closed, null = new item.
  const [editing, setEditing] = useState<EngagementShopItem | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<EngagementShopItem | undefined>(undefined);
  const remove = useAction((id: number) => engagementServiceClient.deleteShopItem({ id }), { success: "Item removed" });

  const items = list.data?.items ?? [];
  const currency = list.data?.currency;

  const columns: Column<EngagementShopItem>[] = [
    { key: "id", header: "#", width: "48px", render: (i) => <span className={styles.position}>{i.id}</span> },
    {
      key: "name",
      header: "Item",
      render: (i) => (
        <div>
          <div className={styles.shopName}>{i.name}</div>
          <div className={styles.shopMeta}>{i.roleName ? `Gives ${i.roleName}` : "Role deleted: fix or remove this item"}</div>
        </div>
      ),
    },
    { key: "price", header: "Price", align: "right", render: (i) => formatMoney(currency, i.price) },
    {
      key: "stock",
      header: "Stock",
      align: "right",
      width: "90px",
      hideOnMobile: true,
      render: (i) => (i.limited ? (i.stock > 0 ? i.stock.toLocaleString() : "Sold out") : "∞"),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "88px",
      render: (i) => (
        <div className={styles.cellActions} onClick={(e) => e.stopPropagation()}>
          <IconButton icon="edit" label={`Edit ${i.name}`} onClick={() => setEditing(i)} />
          <IconButton icon="trash" label={`Remove ${i.name}`} danger onClick={() => setDeleting(i)} />
        </div>
      ),
    },
  ];

  return (
    <>
      <Card
        title="Shop"
        description={`Roles members can buy with ${session.prefix}buy or on their Me page. Staff roles can't be sold.`}
        padded={false}
        actions={
          <Button size="sm" icon="plus" disabled={items.length >= MAX_SHOP_ITEMS} onClick={() => setEditing(null)}>
            Add item
          </Button>
        }
      >
        {list.error && !list.data ? (
          <ErrorState message={list.error} onRetry={() => void list.reload()} />
        ) : (
          <Table
            columns={columns}
            rows={items}
            rowKey={(i) => i.id}
            onRowClick={(i) => setEditing(i)}
            loading={list.loading}
            empty={
              <EmptyState
                compact
                icon={<Icon name="gift" size={28} />}
                title="The shop is empty"
                description="Add a role for members to buy."
              />
            }
          />
        )}
      </Card>

      {editing !== undefined && (
        <ItemEditor
          item={editing ?? undefined}
          onClose={() => setEditing(undefined)}
          onSaved={(result) => {
            list.setData(result);
            setEditing(undefined);
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Remove item?"
        message={deleting && `${deleting.name} leaves the shop. Members who bought it keep the role.`}
        confirmLabel="Remove"
        danger
        busy={remove.busy}
        onCancel={() => setDeleting(undefined)}
        onConfirm={async () => {
          if (!deleting) return;
          const result = await remove.run(deleting.id);
          if (result) list.setData(result);
          setDeleting(undefined);
        }}
      />
    </>
  );
};

const ItemEditor: React.FC<{
  item: EngagementShopItem | undefined;
  onClose: () => void;
  onSaved: (list: Awaited<ReturnType<typeof engagementServiceClient.listShop>>) => void;
}> = ({ item, onClose, onSaved }) => {
  const [draft, setDraft] = useState<EngagementShopItem>(
    item ?? { id: 0, name: "", description: "", roleId: "", roleName: "", price: 500, limited: false, stock: 10 },
  );
  const patch = (change: Partial<EngagementShopItem>) => setDraft((d) => ({ ...d, ...change }));
  const save = useAction(() => engagementServiceClient.saveShopItem(draft), {
    success: item ? "Item saved" : "Item added",
    toastError: false,
  });
  const canSave = !!draft.name.trim() && !!draft.roleId && !save.busy;

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!save.busy}
      title={item ? `Edit ${item.name}` : "New shop item"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.busy}
            disabled={!canSave}
            onClick={async () => {
              const result = await save.run();
              if (result) onSaved(result);
            }}
          >
            {item ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <Stack gap={14}>
        <Field label="Role" help="Given to the buyer. Taproot's role must be above it in Root's role list.">
          <RoleSelect value={draft.roleId || undefined} excludePrivileged onChange={(roleId) => patch({ roleId: roleId ?? "" })} />
        </Field>
        <Field label="Name" help="What members type after buy (or the item number).">
          <TextInput value={draft.name} onChange={(name) => patch({ name })} maxLength={64} placeholder="VIP" />
        </Field>
        <Field label="Description" help="Optional.">
          <TextInput value={draft.description} onChange={(description) => patch({ description })} maxLength={200} />
        </Field>
        <Field label="Price">
          <NumberInput value={draft.price} onChange={(price) => patch({ price })} min={0} max={1_000_000_000} width={140} />
        </Field>
        <Toggle checked={draft.limited} onChange={(limited) => patch({ limited })} label="Limited stock" description="Sells out when stock runs out." />
        {draft.limited && (
          <Field label="In stock">
            <NumberInput value={draft.stock} onChange={(stock) => patch({ stock })} min={0} max={1_000_000} width={120} />
          </Field>
        )}
        {save.error && <Banner tone="error">{save.error}</Banner>}
      </Stack>
    </Modal>
  );
};

export default EconomySettings;
