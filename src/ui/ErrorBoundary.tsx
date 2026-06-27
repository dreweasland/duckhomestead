import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback: ReactNode;
}
interface State {
  failed: boolean;
}

/**
 * Isolates a crash-prone subtree (the Pixi canvas) so a render/runtime error
 * there shows a fallback instead of white-screening the whole game — the HUD,
 * panels, and autosave keep working.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('Canvas error (isolated by ErrorBoundary):', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
