import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./Shell.module.css";
import { cx } from "../lib/cx";
import { useSession } from "../lib/session";
import { STAFF_LEVEL_LABEL } from "../lib/labels";
import {
  ALL_PAGES,
  NavParams,
  NavProvider,
  NavValue,
  PageKey,
  canOpen,
  defaultPage,
  visibleGroups,
} from "../lib/nav";
import { Badge, ErrorBoundary, Icon, IconButton, useToast } from "../components";
import { PAGE_COMPONENTS } from "./pages";

// App chrome: a left sidebar on wide screens, a top bar with a drop-down
// menu below 760px. Routing is plain state; pages the caller's level can't
// open are unreachable and we snap back to the default if the level drops.

export const Shell: React.FC = () => {
  const { level } = useSession();
  const [route, setRoute] = useState<{ page: PageKey; params: NavParams }>(() => ({
    page: defaultPage(level),
    params: {},
  }));

  useEffect(() => {
    if (!canOpen(route.page, level)) setRoute({ page: defaultPage(level), params: {} });
  }, [level, route.page]);

  const navigate = useCallback(
    (page: PageKey, params: NavParams = {}) => {
      if (!canOpen(page, level)) return;
      setRoute({ page, params });
      window.scrollTo({ top: 0 });
    },
    [level],
  );

  const nav = useMemo<NavValue>(() => ({ ...route, navigate }), [route, navigate]);
  const page = canOpen(route.page, level) ? route.page : defaultPage(level);
  const View = PAGE_COMPONENTS[page];

  return (
    <NavProvider value={nav}>
      <div className={styles.shell}>
        <Sidebar page={page} navigate={navigate} />
        <div className={styles.column}>
          <TopBar page={page} navigate={navigate} />
          <main className={styles.content}>
            <div className={styles.contentInner}>
              <ErrorBoundary key={page}>
                <View />
              </ErrorBoundary>
            </div>
          </main>
        </div>
      </div>
    </NavProvider>
  );
};

interface NavProps {
  page: PageKey;
  navigate: (page: PageKey) => void;
}

const Brand: React.FC = () => {
  const { session } = useSession();
  return (
    <div className={styles.brand}>
      <span className={styles.brandMark} aria-hidden>
        🌱
      </span>
      <div className={styles.brandText}>
        <span className={styles.brandName}>Taproot</span>
        {session.communityName && <span className={styles.brandCommunity}>{session.communityName}</span>}
      </div>
    </div>
  );
};

const NavList: React.FC<NavProps> = ({ page, navigate }) => {
  const { level } = useSession();
  return (
    <nav className={styles.nav} aria-label="Taproot">
      {visibleGroups(level).map((group) => (
        <div key={group.label} className={styles.navGroup}>
          {/* Members only have one page; a lone "You" heading is noise. */}
          {level > 0 && <div className={styles.navGroupLabel}>{group.label}</div>}
          {group.pages.map((p) => (
            <button
              key={p.key}
              type="button"
              className={cx(styles.navItem, p.key === page && styles.navItemActive)}
              aria-current={p.key === page ? "page" : undefined}
              onClick={() => navigate(p.key)}
            >
              <Icon name={p.icon} size={16} />
              <span>{p.label}</span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
};

const Identity: React.FC = () => {
  const { session, level, refresh } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.identity}>
      <div className={styles.identityText}>
        <span className={styles.identityName}>{session.nickname || "You"}</span>
        <Badge tone={level > 0 ? "brand" : "neutral"}>{STAFF_LEVEL_LABEL[level]}</Badge>
      </div>
      <IconButton
        icon="refresh"
        label="Refresh your access"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await refresh();
          setBusy(false);
          toast.info("Refreshed your Taproot access.");
        }}
      />
    </div>
  );
};

const Sidebar: React.FC<NavProps> = (props) => (
  <aside className={styles.sidebar}>
    <Brand />
    <NavList {...props} />
    <Identity />
  </aside>
);

const TopBar: React.FC<NavProps> = ({ page, navigate }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = ALL_PAGES.find((p) => p.key === page)?.label ?? "";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={styles.topBar}>
      <div className={styles.topBarRow}>
        <span className={styles.topBarBrand} aria-hidden>
          🌱
        </span>
        <button
          type="button"
          className={styles.topBarMenu}
          aria-expanded={open}
          aria-haspopup="true"
          onClick={() => setOpen((o) => !o)}
        >
          <span className={styles.topBarTitle}>
            Taproot <span className={styles.topBarSep}>/</span> {label}
          </span>
          <Icon name={open ? "close" : "menu"} size={18} />
        </button>
      </div>
      {open && (
        <div className={styles.menu}>
          <NavList
            page={page}
            navigate={(p) => {
              navigate(p);
              setOpen(false);
            }}
          />
          <Identity />
        </div>
      )}
    </div>
  );
};
