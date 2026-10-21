/**
 * Plugin de configuração do Expo: ASSINATURA DE RELEASE SEGURA no Android.
 *
 * O template do `expo prebuild` assina o build `release` com a chave de DEBUG (pública, igual para todo mundo). Um APK/AAB assim NÃO pode ir a cliente nem à Google Play.
 * Este plugin troca isso por uma assinatura de produção vinda de FORA do repositório (nunca versione keystore nem senha):
 *
 *   CORTEX_UPLOAD_STORE_FILE        caminho do .jks/.keystore
 *   CORTEX_UPLOAD_STORE_PASSWORD
 *   CORTEX_UPLOAD_KEY_ALIAS
 *   CORTEX_UPLOAD_KEY_PASSWORD
 *
 * (variáveis de ambiente ou propriedades do Gradle, ex.: ~/.gradle/gradle.properties).
 * Sem a keystore o build de release é RECUSADO (falha fechada). Para um APK de TESTE INTERNO assinado com a chave de debug, passe
 * `-Pcortex.allowDebugSignedRelease=true` — o artefato resultante não é distribuível.
 *
 * `android/` é gerado (CNG) e fica fora do git: por isso a regra mora aqui, no plugin, e é reaplicada a cada `expo prebuild`.
 */
const { withAppBuildGradle } = require('@expo/config-plugins');

const prop = (name) => `(System.getenv('${name}') ?: findProperty('${name}'))`;

const RELEASE_SIGNING = `
        release {
            def cortexStoreFile = ${prop('CORTEX_UPLOAD_STORE_FILE')}
            if (cortexStoreFile) {
                storeFile file(cortexStoreFile)
                storePassword ${prop('CORTEX_UPLOAD_STORE_PASSWORD')}
                keyAlias ${prop('CORTEX_UPLOAD_KEY_ALIAS')}
                keyPassword ${prop('CORTEX_UPLOAD_KEY_PASSWORD')}
            }
        }`;

const GUARD = `
// CÓRTEX: release só com keystore de produção (ou teste interno explícito) — nunca com a chave de debug por engano.
gradle.taskGraph.whenReady { graph ->
    def wantsRelease = graph.allTasks.any { t -> t.name.toLowerCase().contains('release') && (t.name.startsWith('assemble') || t.name.startsWith('bundle') || t.name.startsWith('package')) }
    def hasKeystore = ${prop('CORTEX_UPLOAD_STORE_FILE')}
    if (wantsRelease && !hasKeystore && findProperty('cortex.allowDebugSignedRelease') != 'true') {
        throw new GradleException('Build de RELEASE recusado: defina CORTEX_UPLOAD_STORE_FILE, CORTEX_UPLOAD_STORE_PASSWORD, CORTEX_UPLOAD_KEY_ALIAS e CORTEX_UPLOAD_KEY_PASSWORD (keystore de produção, fora do repositório). Para um APK de TESTE INTERNO assinado com a chave de debug (nao distribuivel) use -Pcortex.allowDebugSignedRelease=true')
    }
}
`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (gradle.includes('CORTEX_UPLOAD_STORE_FILE')) return cfg; // já aplicado

    // 1. config de assinatura "release" logo depois da "debug"
    const debugBlock = /(debug \{\s*storeFile file\('debug\.keystore'\)[\s\S]*?keyPassword 'android'\s*\})/;
    if (!debugBlock.test(gradle)) throw new Error('with-release-signing: bloco signingConfigs.debug não encontrado no build.gradle gerado (template do Expo mudou?)');
    gradle = gradle.replace(debugBlock, `$1${RELEASE_SIGNING}`);

    // 2. buildType release usa a assinatura de produção quando houver keystore; senão (teste interno liberado) cai na de debug
    const releaseSigning = /(release \{\s*\/\/ Caution![\s\S]*?\n\s*\/\/ see [^\n]*\n\s*)signingConfig signingConfigs\.debug/;
    if (!releaseSigning.test(gradle)) throw new Error('with-release-signing: bloco buildTypes.release não encontrado no build.gradle gerado (template do Expo mudou?)');
    gradle = gradle.replace(releaseSigning, '$1signingConfig signingConfigs.release.storeFile ? signingConfigs.release : signingConfigs.debug');

    // 3. guarda que recusa release sem keystore
    gradle += GUARD;

    cfg.modResults.contents = gradle;
    return cfg;
  });
};
