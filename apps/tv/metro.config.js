// O painel de TV usa `react-native` = alias de `react-native-tvos`. O npm instala, como peer das `virtualized-lists` (aninhadas no tvos), um SEGUNDO `react-native` 0.86.2
// em `node_modules/react-native/node_modules/react-native`. Sem isto o Metro empacota os dois e a partida falha em runtime com "TypeError: property is not writable"
// (o `setUpFuseboxReactDevToolsDispatcher` é definido duas vezes). Toda resolução de `react-native` e `react-native/*` parte da raiz do app: sempre o pacote tvos.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const defaultResolve = config.resolver.resolveRequest;
const appEntry = path.join(__dirname, 'index.ts');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'react-native' || moduleName.startsWith('react-native/')) {
    context = { ...context, originModulePath: appEntry };
  }
  return (defaultResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
