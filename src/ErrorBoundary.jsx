import React from 'react';
import {Button} from './ui';

// A broken panel must never take the whole app down. Without a boundary an uncaught render error unmounts the React
// root and leaves a blank page with no explanation, which is what happened on 6 November when a simulation-only field
// was missing from a live wallet. The reference shown here is the error's own message, so a screenshot is actionable.
export class ErrorBoundary extends React.Component {
  constructor(props){ super(props); this.state = {error: null}; }
  static getDerivedStateFromError(error){ return {error}; }
  componentDidCatch(error, info){
    // Local only: the console is the operator's, and nothing here is sent anywhere.
    if (typeof console !== 'undefined') console.error('Eupova screen failed to render:', error?.message, String(info?.componentStack ?? '').slice(0, 600));
  }
  render(){
    if (!this.state.error) return this.props.children;
    return <div className="app"><main id="main"><section className="panel">
      <h1>This screen could not be shown.</h1>
      <p>Nothing has been sent and nothing has changed. Reload to try again. If it keeps happening, send this reference:</p>
      <p><code>{String(this.state.error?.message ?? 'unknown error').slice(0, 160)}</code></p>
      <Button onClick={() => location.reload()}>Reload</Button>
    </section></main></div>;
  }
}
export default ErrorBoundary;
