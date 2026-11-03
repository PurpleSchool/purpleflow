import { Component, type ReactNode } from 'react';

/** Ошибка при отрисовке не должна оставлять пустое окно: показываем причину и кнопку перезагрузки. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 40, maxWidth: 640 }}>
        <h2>Окно упало с ошибкой</h2>
        <p>Прогоны продолжают работать в ядре — перезагрузка окна их не останавливает.</p>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{error.message}</pre>
        <button onClick={() => location.reload()}>Перезагрузить окно</button>
      </div>
    );
  }
}
