import React from "react";
import { sessionServiceClient } from "@taproot/gen-client";
import styles from "./App.module.css";
import { Button, ErrorBoundary, Spinner, ToastProvider } from "./components";
import { LookupsProvider } from "./lib/lookups";
import { SessionProvider } from "./lib/session";
import { useRpc } from "./lib/useRpc";
import { Shell } from "./shell/Shell";

// Loads the caller's session, then hands off to the Shell. Nothing else can
// render without it: the level decides which pages exist.

const App: React.FC = () => (
  <ErrorBoundary>
    <ToastProvider>
      <SessionGate />
    </ToastProvider>
  </ErrorBoundary>
);

const SessionGate: React.FC = () => {
  const { data: session, error, loading, reload } = useRpc(() => sessionServiceClient.getSession());

  if (!session) {
    return (
      <div className={styles.splash}>
        <div className={styles.splashMark} aria-hidden>
          🌱
        </div>
        {error && !loading ? (
          <>
            <h1 className={styles.splashTitle}>Taproot couldn't start</h1>
            <p className={styles.splashText}>{error}</p>
            <Button variant="primary" icon="refresh" onClick={() => void reload()}>
              Try again
            </Button>
          </>
        ) : (
          <Spinner label="Loading Taproot…" />
        )}
      </div>
    );
  }

  return (
    <SessionProvider session={session} refresh={reload}>
      <LookupsProvider>
        <Shell />
      </LookupsProvider>
    </SessionProvider>
  );
};

export default App;
