import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional label so the recovery screen names which area failed. */
  label?: string;
}
interface State {
  error: Error | null;
}

/**
 * Catches render-time exceptions so one failing subtree can't blank the entire
 * window (the app has no other safety net). Shows the error + a reset so the
 * user can recover without restarting. Wrap the whole app, and optionally wrap
 * heavy subtrees (e.g. the Second Brain graph) so a failure there is contained.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // Surface it in the console for diagnosis; the UI shows a friendly panel.
    console.error('UI crashed' + (this.props.label ? ` in ${this.props.label}` : ''), error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-full w-full flex items-center justify-center p-8 bg-zinc-950 text-zinc-100">
        <div className="max-w-lg w-full bg-zinc-900 border border-red-500/30 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
            <h2 className="text-sm font-bold uppercase tracking-widest text-red-300">
              {this.props.label ? `${this.props.label} hit an error` : 'Something went wrong'}
            </h2>
          </div>
          <p className="text-[13px] text-zinc-400">
            The interface caught an error instead of going blank. Your data is safe — it lives in the
            local database, not in the screen. Try again, and if it keeps happening, copy the message below.
          </p>
          <pre className="text-[11px] text-red-200/90 bg-black/40 border border-zinc-800 rounded-md p-3 overflow-auto max-h-48 whitespace-pre-wrap break-words">
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ''}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={this.reset}
              className="px-3 py-1.5 rounded-md text-[12px] font-bold uppercase tracking-wider bg-indigo-600 hover:bg-indigo-500 text-white"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 rounded-md text-[12px] text-zinc-300 hover:text-white hover:bg-zinc-800 border border-zinc-700"
            >
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
