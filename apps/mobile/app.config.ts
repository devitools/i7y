import type { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const production = process.env.I7Y_BUILD_VARIANT === 'production';
  const secureTransport = production || process.env.I7Y_BUILD_VARIANT === 'device-development';
  return {
    ...config,
    name: 'i7y', slug: 'i7y', owner: 'wilcorrea', version: '0.1.0',
    scheme: 'com.devitools.i7y.mobile', orientation: 'default', userInterfaceStyle: 'automatic',
    icon: './assets/icon.png',
    ios: {
      bundleIdentifier: 'com.devitools.i7y.mobile', supportsTablet: true,
      entitlements: { 'aps-environment': production ? 'production' : 'development' },
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        ...(secureTransport ? {} : { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true } }),
      },
    },
    android: {
      package: 'com.devitools.i7y.mobile', allowBackup: false,
      ...(process.env.GOOGLE_SERVICES_JSON ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON } : {}),
      adaptiveIcon: { foregroundImage: './assets/icon.png', backgroundColor: '#4f46e5' },
    },
    web: { output: 'single', favicon: './assets/icon.png' },
    plugins: [
      'expo-router', 'expo-secure-store', 'expo-localization',
      ['expo-notifications', { color: '#4f46e5', defaultChannel: 'incidents', mode: production ? 'production' : 'development' }],
      ['expo-splash-screen', { backgroundColor: '#4f46e5', image: './assets/icon.png', imageWidth: 120, dark: { backgroundColor: '#171724' } }],
      ['expo-build-properties', { android: { usesCleartextTraffic: !secureTransport } }],
      './plugins/with-installation-directory.cjs',
    ],
    experiments: { typedRoutes: true },
    extra: {
      ...config.extra,
      buildVariant: process.env.I7Y_BUILD_VARIANT === 'simulator' ? 'simulator' : production ? 'production' : 'development',
      pushGatewayUrl: process.env.EXPO_PUBLIC_I7Y_PUSH_GATEWAY_URL ?? '',
      pushEnvironment: production ? 'production' : 'sandbox',
    },
  };
};
