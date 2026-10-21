# App do mecânico e da equipe — "CÓRTEX Equipe" (`apps/mobile`, Expo / Android)

Login com MFA (TOTP), início, **agenda** (confirmar com canal e quem confirmou, cancelar) e **ordens de serviço** (lista e detalhe com histórico de status). Só Android é suportado nesta fase (sem iOS).

| Item | Situação |
|---|---|
| Identificação | nome **CÓRTEX Equipe**, pacote `com.lnsystem.mobile` (mantido por compatibilidade), `versionName 1.0.0`, `versionCode 1`, `targetSdk 36` |
| Stack | Expo 57, React Native 0.86, react-navigation, zustand, axios, `expo-secure-store` (tokens) |
| API | `EXPO_PUBLIC_API_URL` (padrão de **desenvolvimento** `http://10.0.2.2:3001/api`, o host visto pelo emulador). **Build de release sem `EXPO_PUBLIC_API_URL` https lança erro na partida** (falha fechada; não existe opção de ignorar certificado) |
| Sessão | só 401/403 do servidor encerram a sessão; falha de rede não desloga; timeout de 15 s |
| Primeiro acesso | quem tem **senha temporária** recebe a mensagem "troque a senha no Admin Web" (o app não tem tela de troca; decisão 157) |
| Privacidade do pacote | `allowBackup=false`; permissões de armazenamento e de sobreposição de tela **bloqueadas**; ficam INTERNET, VIBRATE e biometria (`USE_BIOMETRIC`/`USE_FINGERPRINT`, trazidas pelo módulo de autenticação local) |
| Testes | nenhum automatizado do app; `npm run type-check` |

## Estado comprovado em 2026-10-18 (Windows 11, JDK 17, Android SDK 36)

| Etapa | Resultado |
|---|---|
| `expo prebuild` (gera `android/`, **não versionado**) | ✔ |
| `assembleDebug` | ✔ APK instalado em **emulador** (WHPX) e usado: login, agenda, ordens de serviço, sair |
| `assembleRelease` **sem keystore** | **recusado de propósito** (guarda do plugin `with-release-signing`) |
| `assembleRelease` de **teste interno** (`-Pcortex.allowDebugSignedRelease=true`, URL inválida de propósito) | ✔ APK v2-assinado com a **chave de debug**, `debuggable=false` — **não distribuível** |
| APK/AAB assinado com chave de produção | **não gerado** (exige keystore do proprietário) |
| Aparelho físico, Play Store, iOS | **não testados / não existem** |

## Como construir (Windows)

1. **Não construa em pasta com acento** (ex.: `Minha bagunça`): o Gradle quebra com o caminho. Copie `apps/mobile` para um caminho ASCII (ex.: `C:\cx-build\mobile`; `node_modules` por `npm install` na cópia, com as versões já fixadas).
2. Ambiente: `ANDROID_HOME`/`ANDROID_SDK_ROOT` (plataforma 36, build-tools 35 e 36, NDK 27.1), `JAVA_HOME` = JDK 17, `JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8`.
3. `npx expo prebuild --platform android --no-install --clean`
4. Debug (com Metro: `npx expo start --android`, que escuta IPv4): `cd android && ./gradlew.bat assembleDebug`
5. **Release** com keystore do proprietário (nunca no repositório): definir `CORTEX_UPLOAD_STORE_FILE`, `CORTEX_UPLOAD_STORE_PASSWORD`, `CORTEX_UPLOAD_KEY_ALIAS`, `CORTEX_UPLOAD_KEY_PASSWORD` e `EXPO_PUBLIC_API_URL=https://…`; depois `./gradlew.bat assembleRelease` (APK) ou `bundleRelease` (AAB). Sem as variáveis o build **falha** com "Build de RELEASE recusado".
6. Conferir: `aapt2 dump badging app-release.apk` (pacote, versão, permissões) e `apksigner verify --print-certs` (certificado **de produção**, não "Android Debug").

Saída: `android/app/build/outputs/apk/release/app-release.apk`. Distribuição (Play Store, MDM, link interno) é decisão do proprietário.

Conhecido e não corrigido:
- A agenda pede só os 50 primeiros agendamentos (`limit: 50`, sem paginação); a lista de OS traz as 50 mais novas.
- **Sem o portão de equipamento:** o app não se registra nem envia identidade de equipamento (diferente do PDV, [DISPOSITIVOS](DISPOSITIVOS.md)); o servidor só o exige se a empresa incluir o perfil em `devices.requiredUserTypes`. Pendência 111 (prova depende de aparelho).
- Sem tela de troca de senha (usar o Admin Web).

Próximos passos: [ROADMAP](ROADMAP.md). Decisão 159: [DECISIONS](DECISIONS.md).
