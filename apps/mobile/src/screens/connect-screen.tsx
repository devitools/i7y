import { useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppHeader } from '@/components/app-header';
import { AuthorizationCancelledError, UnsupportedServerError, normalizeServerUrl } from '@/core/client';
import { allowLocalServers } from '@/core/config';
import { t } from '@/locales';
import { useI7y } from '@/state/session';
import { useTheme } from '@/theme/colors';

export default function ConnectScreen() {
  const c = useTheme();
  const state = useI7y();
  const [url, setUrl] = useState(state.serverUrl);
  const [pending, setPending] = useState(false);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const busy = state.busy || pending;
  let valid = false;
  try { valid = !!normalizeServerUrl(url, allowLocalServers); } catch {}
  async function login() {
    if (busy || submitting.current || !valid) return;
    submitting.current = true;
    Keyboard.dismiss(); setError(''); setPending(true);
    try { await state.signIn(url); }
    catch (cause) {
      if (!(cause instanceof AuthorizationCancelledError)) setError(t(cause instanceof UnsupportedServerError ? 'unsupportedServer' : 'signInError'));
    } finally { submitting.current = false; setPending(false); }
  }
  return <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.background }}>
    <AppHeader />
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingTop: 40, alignItems: 'center', flexGrow: 1 }}>
        <View style={{ width: '100%', maxWidth: 460, padding: 24, paddingBottom: 28, backgroundColor: c.surface, borderWidth: 1, borderColor: c.separator, borderRadius: 14, gap: 18 }}>
          <Text accessibilityRole="header" style={{ color: c.text, fontSize: 24, lineHeight: 30, fontWeight: '600' }}>{t('signIn')}</Text>
          <View style={{ gap: 6 }}>
            <View style={{ minHeight: 60, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: focused ? 2 : 1, borderColor: focused ? c.brand : c.outline }}>
              <Text style={{ color: focused ? c.brand : c.muted, fontSize: 12, lineHeight: 16 }}>{t('backendUrl')}</Text>
              <TextInput accessibilityLabel={t('backendUrl')} value={url} onChangeText={value => { setUrl(value); setError(''); }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} editable={!busy} autoCapitalize="none" autoCorrect={false} autoComplete="url" keyboardType="url" returnKeyType="go" onSubmitEditing={() => void login()} placeholder={t('serverPlaceholder')} placeholderTextColor={c.muted} selectionColor={c.brand} style={{ color: c.text, fontSize: 15, lineHeight: 22, padding: 0, minHeight: 26 }} />
            </View>
            <Text style={{ color: c.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 12 }}>{t('savedServer')}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={t('browserLogin')} accessibilityState={{ disabled: busy || !valid, busy }} onPress={() => void login()} disabled={busy || !valid} style={({ pressed }) => ({ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 44, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: c.brand, borderRadius: 12, opacity: busy || !valid ? 0.5 : pressed ? 0.8 : 1 })}>
            {busy ? <ActivityIndicator color="#ffffff" size="small" /> : <View style={{ width: 18, height: 15, borderWidth: 2, borderColor: '#ffffff', borderRadius: 2, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#ffffff', fontSize: 17, lineHeight: 20, fontWeight: '700' }}>↑</Text></View>}
            <Text style={{ color: '#ffffff', fontSize: 14, fontWeight: '500' }}>{t(busy ? 'working' : 'browserLogin')}</Text>
          </Pressable>
          {!!state.authCode && <View style={{ gap: 8 }} accessibilityLiveRegion="polite"><Text style={{ color: c.muted, fontSize: 14 }}>{t('waitingLogin')}</Text><Text selectable style={{ color: c.text, fontSize: 24, fontWeight: '600', letterSpacing: 3 }}>{state.authCode}</Text><Text style={{ color: c.muted, fontSize: 12, lineHeight: 17 }}>{t('compareCode')}</Text></View>}
          {!!error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: c.critical, fontSize: 14, lineHeight: 20 }}>{error}</Text>}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
