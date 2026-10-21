# Painel de TV — "CÓRTEX Painel" (`apps/tv`, Expo Android TV)

Painel de parede da oficina: **agenda do dia** e **OS em andamento / prontas**, com login e MFA feitos uma vez.

| Item | Situação |
|---|---|
| Identificação | nome **CÓRTEX Painel**, pacote `com.lnsystem.tv` (mantido por compatibilidade), `versionName 1.0.0`, `versionCode 1`, `targetSdk 36`, atividade `leanback` |
| Stack | `react-native-tvos` 0.86, Expo 57, `@react-native-tvos/config-tv` (`isTV: true`), zustand, `expo-secure-store` |
| API | `EXPO_PUBLIC_API_URL` (padrão de desenvolvimento `http://10.0.2.2:3001/api`); leitura de `/appointments` e `/service-orders`. Release sem URL https lança erro na partida |
| Resiliência | cada coluna carrega à parte (`allSettled`): um módulo desligado (403) não congela o painel; falha de rede não desloga |
| Primeiro acesso | quem tem senha temporária recebe a mensagem "troque a senha no Admin Web" |
| Privacidade do pacote | `allowBackup=false`; permissões de armazenamento e sobreposição bloqueadas |
| Testes | nenhum automatizado do app; `npm run type-check` |

## Estado comprovado em 2026-10-18

| Etapa | Resultado |
|---|---|
| `expo prebuild` + `assembleDebug` | ✔ APK de debug (x86_64 para o emulador; 3 ABIs no build completo) |
| **Defeito encontrado e corrigido:** o app **nunca tinha rodado** — o npm instala um segundo `react-native` 0.86.2 aninhado (peer das `virtualized-lists` do tvos) e o Metro empacotava os dois: tela vermelha "TypeError: property is not writable" na partida | `apps/tv/metro.config.js` força toda resolução de `react-native` para o pacote tvos; depois disso o app abre |
| Execução em **emulador Android TV** (API 36, x86_64, imagem `android-tv`), debug com Metro e a API de desenvolvimento | ✔ login **só com teclas de D-pad** (selecionar campo, digitar, voltar para fechar o teclado, descer, confirmar); painel mostra agenda do dia, OS em andamento e veículos prontos da filial; sessão **persiste** ao reiniciar o app |
| `assembleRelease` de teste interno (chave de debug, `allowBackup=false`, sem as permissões bloqueadas) | ✔ gerado com o `metro.config.js`, **instalado e aberto no emulador de TV** (tela de login sem erro; a URL de release é https inválida de propósito, então não faz login) — hash no relatório mestre |
| Aparelho de TV físico, controle remoto real, rolagem com muitos itens, tela apagada/standby | **NÃO TESTADOS** |
| Release/AAB com keystore de produção | **não gerado** (exige keystore do proprietário) |

O mesmo plugin de assinatura do app do mecânico vale aqui (`plugins/with-release-signing.js`): release **recusado** sem keystore. Passo a passo de construção em [MOBILE](MOBILE.md) (substituir `apps/mobile` por `apps/tv`).

Conhecido e não corrigido:
- Não há tela de sair nem "manter a tela acesa" (`expo-keep-awake` não está instalado).
- O painel lê as 100 OS mais novas e filtra "em andamento" em memória.
- A credencial da TV é um login comum de usuário (vale tudo que o papel permite) — [DECISÃO NECESSÁRIA] de um papel `DISPLAY` só-leitura ([DECISIONS](DECISIONS.md#pendentes)).
- Agendamentos antigos sem filial não aparecem (o painel filtra pela filial).

Próximos passos: [ROADMAP](ROADMAP.md). Decisão 159: [DECISIONS](DECISIONS.md).
