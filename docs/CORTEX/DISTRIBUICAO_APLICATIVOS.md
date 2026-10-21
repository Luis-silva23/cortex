# Distribuição dos aplicativos — o que existe, como construir, instalar e atualizar

Escrito para: quem constrói e entrega os aplicativos ao cliente. Data-base **2026-10-18**. Estado de cada artefato: **gerado** (existe e foi verificado), **testado** (usado de verdade) ou **não gerado**. Nenhum artefato aqui é distribuível ao cliente **ainda**: faltam o endereço do servidor de produção/staging com HTTPS e as chaves de assinatura do proprietário.

## 1. Visão geral

| Aplicativo | Plataforma | Artefato | Estado | O que impede entregar ao cliente |
|---|---|---|---|---|
| Admin Web, Super Admin | navegador (Next.js) | não há artefato: sobem no servidor ([PRODUCAO](PRODUCAO.md)) | testado em navegador (Playwright) | servidor com HTTPS (staging/produção não existem) |
| Balcão | navegador (Vite, estático) | `apps/balcao/dist` | testado em navegador | idem; servir sob o domínio da empresa |
| PDV Desktop | Windows 10+ 64 bits | `CORTEX-PDV-Setup-1.0.0.exe` (NSIS, por usuário) | **gerado** e aplicativo **iniciado** (smoke) | `VITE_API_URL` de produção no build; **assinatura de código** (sem ela o Windows mostra SmartScreen) |
| CÓRTEX Equipe (mecânico) | Android 7.0+ (minSdk 24) | `app-release.apk` (teste interno, chave de debug) | **gerado**; build de debug **testado em emulador** | `EXPO_PUBLIC_API_URL` https; **keystore do proprietário**; escolher canal (loja/MDM/link) |
| CÓRTEX Painel (TV) | Android TV (minSdk 24) | `app-release.apk` (teste interno) | **gerado**; debug **testado em emulador Android TV** (D-pad) e release aberto no emulador | idem |
| AAB (Google Play) | Android | — | **não gerado** | keystore e conta de desenvolvedor do proprietário |
| iOS, Linux, macOS | — | — | **não gerados** (não há alvo nesta fase) | decisão do proprietário |

**Atenção — o que o PDV e os APKs gerados fazem hoje:** o endereço do servidor é **fixado no build** (`VITE_API_URL` / `EXPO_PUBLIC_API_URL`) e, em produção, tem de ser **https**. Os artefatos desta rodada foram construídos **sem servidor de produção**: o PDV não encontra servidor e os APKs apontam para `https://api.invalido.cortex` de propósito — servem para provar que compilam, instalam e abrem, **não** para uso. A entrega real exige reconstruir cada um com o endereço definitivo.

## 2. PDV Desktop (Windows)

**Construir** (máquina Windows com Node; `npm install` na raiz do monorepo):
1. `cd apps/pdv-desktop`
2. Defina `VITE_API_URL=https://api.<domínio-da-empresa>` (https obrigatório em produção; sem a variável o PDV não tem servidor).
3. `npm run build:win` → `tsc && vite build && electron-builder --win`.
4. Saída: `dist-installer/CORTEX-PDV-Setup-1.0.0.exe` (+ `.blockmap`). Electron **44.9.0** (versão exata exigida pelo electron-builder), NSIS **x64**, instalação **por usuário** (sem administrador).
5. **Assinar** (decisão do proprietário): certificado de assinatura de código; configurar `CSC_LINK`/`CSC_KEY_PASSWORD` no ambiente de build (nunca no repositório). Sem assinatura o instalador funciona, mas o Windows avisa que o editor é desconhecido.
6. Conferir: `sha256sum` do instalador e registrar no controle de versões de entrega.

**Instalar:** executar o `.exe` (cria o atalho "CÓRTEX PDV"); na primeira abertura o equipamento precisa ser **autorizado** pelo administrador ([DISPOSITIVOS](DISPOSITIVOS.md)); depois login do operador. A sessão do operador vive só em memória: nada é restaurado ao reabrir.

**Atualizar:** não há atualização automática (nenhum `electron-updater`/`publish`). Gerar a nova versão (aumentar `version` em `package.json`), distribuir o novo instalador e executá-lo por cima. **Desinstalar:** "Aplicativos" do Windows; os dados ficam no servidor.

**Limites:** só Windows x64; ia32/arm64, Linux e macOS não foram gerados; a verificação do instalador em máquina limpa (sem Node) **não** foi feita além do teste de inicialização do aplicativo empacotado (`npm run smoke:electron`).

## 3. Aplicativos Android (mecânico e TV)

Passo a passo completo em [MOBILE](MOBILE.md) (a TV segue o mesmo, trocando `apps/mobile` por `apps/tv`). Resumo:
- **Build em caminho ASCII** (caminho com acento quebra o Gradle); JDK 17, Android SDK 36, NDK 27.1; Expo gera `android/` (não versionado).
- **Release assinado:** `CORTEX_UPLOAD_STORE_FILE`/`_STORE_PASSWORD`/`_KEY_ALIAS`/`_KEY_PASSWORD` + `EXPO_PUBLIC_API_URL=https://…`; `./gradlew.bat assembleRelease` (APK) ou `bundleRelease` (AAB). **Sem keystore o build falha de propósito.** A chave de debug só serve para teste interno (`-Pcortex.allowDebugSignedRelease=true`) e o APK resultante **não deve ser distribuído**.
- **Verificar:** `aapt2 dump badging` (pacote `com.lnsystem.mobile`/`com.lnsystem.tv`, `versionName 1.0.0`, `versionCode 1`, permissões só INTERNET/VIBRATE/biometria), `apksigner verify --print-certs` (certificado de **produção**), manifesto com `allowBackup=false` e sem `debuggable`.
- **Instalar (sem loja):** `adb install -r <apk>` ou entrega por MDM/link interno com "fontes desconhecidas" habilitadas no aparelho; **atualizar:** instalar o APK de `versionCode` maior, assinado com a **mesma** chave (perder a keystore impede atualizar o aplicativo já instalado: guarde-a em cofre).
- **TV:** o `metro.config.js` do app é obrigatório (evita dois `react-native` no pacote); instalar em Android TV com `adb install` (ou o canal do cliente) e abrir pelo launcher da TV.

## 4. Web (Admin Web, Super Admin, Balcão)

Sobem com o restante do sistema: `docker-compose.yml`/`docker-compose.staging.yml` e o roteiro de [PRODUCAO](PRODUCAO.md) (deploy, migrações como dono, reinício da API, reversão). **Nada disso foi executado em Linux/Docker nesta máquina** — ver [ESTADO_ATUAL_MISSAO_MESTRA](ESTADO_ATUAL_MISSAO_MESTRA.md).

## 5. Lista para liberar uma versão a um cliente

- [ ] servidor com HTTPS no ar e `validar-homologacao.sh` aprovado (staging) — **pendente de infraestrutura**
- [ ] cada aplicativo reconstruído com o endereço definitivo; hash registrado
- [ ] PDV assinado com certificado do proprietário; APK/AAB assinados com a keystore do proprietário (guardada em cofre, com cópia)
- [ ] equipamento do PDV autorizado e conta de administrador com MFA ([PREPARACAO_COMERCIAL](PREPARACAO_COMERCIAL.md) §2)
- [ ] versão anterior conhecida para reversão (instalador/APK anterior guardado)

## 6. Artefatos gerados na rodada de 2026-10-19 (integração final)

Todos com endereço de API **inválido de propósito** (`https://api.invalido.cortex`) e **sem assinatura de produção**: provam que compilam, instalam e abrem; **não** são distribuíveis. Reconstruir com o endereço definitivo e a chave do proprietário.

| Artefato | Caminho | Tamanho (bytes) | SHA-256 | Assinatura | Verificado |
|---|---|---|---|---|---|
| CÓRTEX Equipe (mecânico) | `C:\cx-build\artifacts\2026-10-19\CORTEX-Equipe-1.0.0-internal-debugsigned.apk` | 77 825 406 | `3cfe607a1c7ecbd8c75b46a5849019c2d9ab7ed36a989afe25858b712636cf61` | chave de **debug** (teste interno) | metadados (`aapt2`), assinatura (`apksigner`); instalado e aberto em emulador Android 15 (tela de login renderizada, sem `FATAL EXCEPTION`); fluxo após o login **não** testado (API inválida) |
| CÓRTEX Painel (TV) | `C:\cx-build\artifacts\2026-10-19\CORTEX-Painel-1.0.0-internal-debugsigned.apk` | 77 960 494 | `7417af52e630ba36f87c8e8511dfb752cd65a122db87bafb6137d71d83422ea7` | chave de **debug** (teste interno) | metadados e assinatura; **não** aberto em emulador nesta rodada |
| PDV Desktop (Windows x64, NSIS) | `apps/pdv-desktop/dist-installer/2026-10-19/CORTEX-PDV-Setup-1.0.0.exe` | 111 679 180 | `5D20E1AA29938E611309CD40C5532D434A087E09A1DB648EB9C3003659031281` | **não assinado** (`Get-AuthenticodeSignature` = NotSigned; sem `CSC_LINK`) | `npm run smoke:electron` OK (janela, ponte de impressão, console sem erros, encerramento de sessão ao fechar); instalação em máquina limpa **não** feita |

**Rodada de 2026-10-20 (com a identidade visual aplicada: ícones, símbolo no login, paleta; mesma API inválida de propósito; ainda não distribuíveis):**

| Artefato | Caminho | Tamanho (bytes) | SHA-256 | Assinatura | Verificado |
|---|---|---|---|---|---|
| CÓRTEX Equipe (APK) | `C:\cx-build\artifacts\2026-10-20\CORTEX-Equipe-1.0.0-internal-debugsigned.apk` | 47 040 234 | `2ff3c21debb430c5f067711e32626511226521b268e5a5ec9a08e8e07f3871e9` | chave de **debug** | `aapt2` (pacote `com.lnsystem.mobile`, `allowBackup=false`, permissões INTERNET/VIBRATE/biometria) e `apksigner`; a versão **anterior** deste lote (mesma identidade, sem a correção da cor do placeholder) foi instalada e aberta em emulador Android 15 (login com símbolo, ícone no launcher, sem falha); **esta** versão final não foi reaberta |
| CÓRTEX Painel (APK TV) | `C:\cx-build\artifacts\2026-10-20\CORTEX-Painel-1.0.0-internal-debugsigned.apk` | 47 524 398 | `9765e439f7cf89566e043389824306ad3303a0ca8f717523b4f383ba3d24f15c` | chave de **debug** | manifesto com `android:banner=@drawable/tv_banner` (banner do launcher, **não** visto no launcher do emulador); versão anterior (sem banner) aberta no emulador Android TV, D-pad moveu o foco, sem falha; **esta** versão final instalada e iniciada (processo vivo), sem nova captura |
| PDV Desktop (instalador) | `C:\cx-build\pdv-out\2026-10-20\CORTEX-PDV-Setup-1.0.0.exe` | 111 765 895 | `5EDA5FA01CA77926FFAE63A2938313C496150D09ED1319C5F4C77666C3AC0DAB` | **não assinado** | ícone da marca no executável (`ExtractAssociatedIcon`); `smoke:electron` OK; gerado fora do repositório porque o `electron-builder` falhou com EPERM ao renomear `win-unpacked.tmp` dentro da pasta do projeto (antivírus/bloqueio de arquivo), repetido com sucesso em caminho ASCII |

Atenção: estes APKs foram compilados só para `arm64-v8a` e `x86_64` (`-PreactNativeArchitectures`); aparelhos Android 32 bits (`armeabi-v7a`) **não** rodam esta compilação — para entrega real, incluir a arquitetura necessária.

Observações: (1) o `productName` do PDV voltou a `LN System PDV` (a troca para "CORTEX PDV" mudaria a pasta de dados do Electron e perderia sessão/caixa/`safeStorage` sem migração, e quebrava o teste de identidade visual); o **nome do instalador** (`CORTEX-PDV-Setup`) e o **atalho** ("CÓRTEX PDV") seguem com a marca nova; (2) os ícones dos aplicativos ainda são os padrão do Expo/Electron e a TV não tem banner: falta o **logotipo oficial em arquivo** (vetor/PNG) para gerar ícones, favicon e banner; (3) o `smoke:electron` recusa rodar com `ELECTRON_RUN_AS_NODE` definida no ambiente (remova a variável antes).
