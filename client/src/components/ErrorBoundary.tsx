import React from "react";
import { ErrorState } from "./Feedback";

// Catches render errors so one broken view doesn't blank the whole App.
// "Try again" remounts the subtree. App.tsx wraps each view in one, keyed
// by page, so navigating away also resets it.

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | undefined;
  attempt: number;
}

/** Wrap a subtree; shows ErrorState with a retry if anything inside throws while rendering. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: undefined, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[Taproot] view crashed", error, info.componentStack);
  }

  private retry = () => this.setState((s) => ({ error: undefined, attempt: s.attempt + 1 }));

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <ErrorState
          title="This page hit a problem"
          message={this.state.error.message || "Something went wrong while showing this page."}
          onRetry={this.retry}
        />
      );
    }
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
  }
}
