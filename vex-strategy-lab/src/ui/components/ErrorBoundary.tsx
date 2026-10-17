import { Component, type ReactNode } from 'react';

/** Keeps one panel's render error from unmounting the whole app; shows the error and a retry. */
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.name}]`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card wide" role="alert">
        <h3>{this.props.name} failed to render</h3>
        <pre className="small">{this.state.error.message}</pre>
        <button onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    );
  }
}
