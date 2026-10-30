import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { ThemeProvider, DarkTheme, DefaultTheme } from 'expo-router/react-navigation';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SplashScreen from 'expo-splash-screen';
import { SessionProvider, useI7y } from '@/state/session';
import { t } from '@/locales';
import { AppearanceProvider, useAppearance } from '@/state/appearance';

void SplashScreen.preventAutoHideAsync();
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15000, refetchOnWindowFocus: true }, mutations: { retry: false } } });

function Navigation() {
  const { ready, session } = useI7y();
  useEffect(() => { if (ready) void SplashScreen.hideAsync(); }, [ready]);
  if (!ready) return null;
  return <Stack>
    <Stack.Protected guard={!session}>
      <Stack.Screen name="connect" options={{ title: 'i7y', headerShown: false }} />
    </Stack.Protected>
    <Stack.Protected guard={!!session}>
      <Stack.Screen name="(tabs)" options={{ title: t('incidents'), headerShown: false }} />
      <Stack.Screen name="incident/[id]" options={{ title: t('incident') }} />
    </Stack.Protected>
    <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
  </Stack>;
}

function ThemedApp() {
  const { theme } = useAppearance();
  return <QueryClientProvider client={queryClient}><ThemeProvider value={theme === 'dark' ? DarkTheme : DefaultTheme}><StatusBar style={theme === 'dark' ? 'light' : 'dark'} /><SessionProvider><Navigation /></SessionProvider></ThemeProvider></QueryClientProvider>;
}

export default function RootLayout() {
  return <AppearanceProvider><ThemedApp /></AppearanceProvider>;
}
