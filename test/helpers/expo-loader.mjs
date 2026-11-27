// Låter Node ladda Expo-appens offline.ts, offlinecore.ts och i18n.ts utan telefonen (test/expo-offline.test.js,
// test/expo-i18n.test.js): react, react-native, expo-file-system och appens api.ts byts mot låtsasmoduler i
// expo-fakes.mjs, och relativa importer utan filändelse får .ts. Gäller bara filer under apps/expo/src/.
const FAKES = new URL('./expo-fakes.mjs', import.meta.url).href;
const SWAP = new Set(['react', 'react-native', 'expo-file-system', './api']);
export async function resolve(spec, ctx, next) {
  if ((ctx.parentURL || '').includes('/apps/expo/src/')) {
    if (SWAP.has(spec)) return { url: FAKES, shortCircuit: true };
    if (spec.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(spec)) return next(spec + '.ts', ctx);
  }
  return next(spec, ctx);
}
