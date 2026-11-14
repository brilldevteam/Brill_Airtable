import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

/** Catches render errors so one broken screen shows a recovery message instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Brill Tables crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-card">
          <div className="modal-icon danger"><AlertTriangle size={20} /></div>
          <h2>Something went wrong on this screen</h2>
          <p>Your data is safe — nothing was lost. Reload the page to carry on. If it keeps happening, tell us what you clicked just before.</p>
          <pre>{this.state.error.message}</pre>
          <div className="crash-actions">
            <button className="btn primary" onClick={() => window.location.reload()}>Reload page</button>
            <a className="btn" href="/">Go to all bases</a>
          </div>
        </div>
      </div>
    );
  }
}
