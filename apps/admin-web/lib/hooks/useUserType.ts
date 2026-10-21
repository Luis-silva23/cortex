import { useEffect, useState } from 'react';
import { getCurrentUserClaims } from '@/lib/api';

// O papel vem do JWT em localStorage, que não existe no render de servidor do
// Next (getCurrentUserClaims devolve null lá). Lê-lo direto no corpo do
// componente faria o HTML do servidor divergir do primeiro render do cliente
// (hydration mismatch) em telas que já mostram botões no primeiro paint.
// Por isso o papel só é lido depois de montar; `ready` deixa a tela evitar
// piscar o aviso de "somente leitura" para quem, na verdade, tem permissão.
export function useUserType(): { userType: string | null; ready: boolean } {
  const [state, setState] = useState<{ userType: string | null; ready: boolean }>({
    userType: null,
    ready: false,
  });

  useEffect(() => {
    setState({ userType: getCurrentUserClaims()?.userType ?? null, ready: true });
  }, []);

  return state;
}
