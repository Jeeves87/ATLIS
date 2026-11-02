import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // mirrored to %APPDATA%/atlis/logs/atlis.log via the main process console hook
    console.error('Renderer crash:', error.stack, info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', color: '#f87171', height: '100%', overflow: 'auto' }}>
          <h2 style={{ color: '#e8eaf0' }}>ATLIS renderer error</h2>
          <p>This has been written to the log. Press Ctrl+R to reload.</p>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{this.state.error.stack}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

window.addEventListener('error', (e) => console.error('window.onerror:', e.error?.stack ?? e.message))
window.addEventListener('unhandledrejection', (e) => console.error('unhandledrejection:', e.reason?.stack ?? String(e.reason)))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
