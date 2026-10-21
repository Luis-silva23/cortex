import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Sem isto, qualquer exceção durante o render (ex.: `undefined.length` numa lista) desmontava a
 * árvore inteira e a janela do PDV ficava em BRANCO — o operador de balcão, com o cliente na fila,
 * sem nenhuma pista do que fazer. Agora ele vê uma mensagem e pode recarregar.
 */
class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Erro de renderização no PDV:', error, info.componentStack);
  }

  private handleReload = () => {
    // Este componente fica FORA do roteador (App.tsx), então não há `navigate`: adapta ao roteador em
    // uso — file: (HashRouter) troca o hash e recarrega; http(s): (BrowserRouter) recarrega em /pos.
    if (window.location.protocol === 'file:') {
      window.location.hash = '#/pos';
      window.location.reload();
    } else {
      window.location.assign('/pos');
    }
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Algo deu errado nesta tela</h1>
          <p className="text-gray-600 mb-6">
            O PDV encontrou um erro inesperado. Recarregue para continuar. Se você estava finalizando uma
            venda, confira no Histórico se ela foi registrada antes de repetir.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="px-6 py-3 rounded-lg bg-primary-600 text-white font-semibold hover:bg-primary-700"
          >
            Recarregar
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
