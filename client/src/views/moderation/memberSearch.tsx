import React, { useEffect, useRef, useState } from "react";
import { moderationServiceClient } from "@taproot/gen-client";
import type { MemberRef } from "@taproot/gen-shared";
import { TextInput } from "../../components";
import { cx, RpcState, useRpc } from "../../lib";
import { initial } from "./MemberLink";
import styles from "./moderation.module.css";

// Member search (nickname substring or exact user ID), debounced, plus a
// picker with a dropdown for filter bars.

/** Debounced searchMembers for `query`; skipped while it's blank. */
export function useMemberSearch(query: string, delayMs = 250): RpcState<MemberRef[]> & { term: string } {
  const [term, setTerm] = useState(query.trim());
  useEffect(() => {
    const next = query.trim();
    if (next === "") {
      setTerm("");
      return;
    }
    const timer = setTimeout(() => setTerm(next), delayMs);
    return () => clearTimeout(timer);
  }, [query, delayMs]);

  const state = useRpc(
    async () => (await moderationServiceClient.searchMembers({ query: term })).members,
    [term],
    { skip: term === "" },
  );
  return { ...state, term };
}

/** One member in a list: avatar initial, name and ID. */
export const MemberRow: React.FC<{ member: MemberRef; active?: boolean; onClick: () => void }> = ({
  member,
  active,
  onClick,
}) => (
  <button
    type="button"
    className={cx(styles.memberRow, active && styles.memberRowActive)}
    aria-current={active || undefined}
    onClick={onClick}
  >
    <span className={styles.avatar} aria-hidden>
      {initial(member.nickname)}
    </span>
    <span className={styles.memberName}>{member.nickname || "Unknown member"}</span>
    <span className={styles.memberId}>{member.userId}</span>
  </button>
);

/** Text box that searches as you type and offers matches in a dropdown. */
export const MemberPicker: React.FC<{
  onPick: (member: MemberRef) => void;
  placeholder?: string;
  id?: string;
}> = ({ onPick, placeholder = "Search by name or user ID", id }) => {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const search = useMemberSearch(query);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (m: MemberRef) => {
    onPick(m);
    setQuery("");
    setOpen(false);
  };
  const results = search.term ? search.data ?? [] : [];
  const pending = query.trim() !== search.term || search.loading;

  return (
    <div className={styles.picker} ref={wrap}>
      <TextInput
        id={id}
        value={query}
        onChange={(v) => {
          setQuery(v);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        onEnter={() => results.length > 0 && !pending && pick(results[0])}
        placeholder={placeholder}
        type="search"
        autoComplete="off"
      />
      {open && query.trim() !== "" && (
        <div className={styles.pickerMenu} role="listbox">
          {search.error && !pending ? (
            <p className={styles.pickerNote}>{search.error}</p>
          ) : results.length === 0 ? (
            <p className={styles.pickerNote}>{pending ? "Searching…" : "No members match."}</p>
          ) : (
            results.map((m) => <MemberRow key={m.userId} member={m} onClick={() => pick(m)} />)
          )}
        </div>
      )}
    </div>
  );
};
