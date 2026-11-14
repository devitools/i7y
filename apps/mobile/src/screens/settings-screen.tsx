import { listRowBackground, scrollContentBackground } from '@expo/ui/swift-ui/modifiers';
import { Button, Column, FieldGroup, Host, ListItem, Text as NativeText } from '@expo/ui';
import { useRef, useState, type ReactElement } from 'react';
import { Alert, Linking, Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router/stack';
import { useRouter } from 'expo-router';
import { Notice } from '@/components/ui';
import { PushRegistrationError } from '@/core/push';
import type { PushStatus } from '@/core/types';
import { t, type MessageKey } from '@/locales';
import { useI7y } from '@/state/session';
import { useTheme } from '@/theme/colors';
import { AppHeader } from '@/components/app-header';

const pushMessages: Record<PushStatus, [MessageKey, MessageKey]> = {
  enabled: ['pushEnabled', 'pushEnabledBody'], disabled: ['pushDisabled', 'pushDisabledBody'],
  unconfigured: ['pushUnconfigured', 'pushUnconfiguredBody'], denied: ['pushDenied', 'pushDeniedBody'],
  registering: ['pushRegistering', 'pushDisabledBody'], unavailable: ['pushUnavailable', 'pushUnavailableBody'],
  'pending-revocation': ['pushPending', 'pushPendingBody'],
};
export default function SettingsScreen() {
  const c = useTheme();
  const state = useI7y();
  const router = useRouter();
  const accountEmail = state.session?.record.email;
  const accountName = state.session?.record.name?.trim();
  const hasAccountName = !!accountName && accountName !== accountEmail;
  const accountRole = state.organization ? t(state.organization.role === 'admin' ? 'adminRole' : state.organization.role === 'editor' ? 'editorRole' : 'readerRole') : '';
  const rowColors = { containerColor: c.surface, contentColor: c.text, supportingContentColor: c.muted };
  const neutralAction = (button: ReactElement) => Platform.OS === 'android' ? <ListItem colors={rowColors}>{button}</ListItem> : button;
  const rowModifiers = Platform.OS === 'ios' ? [listRowBackground(c.surface)] : undefined;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const visibleError = state.pushStatus === 'enabled' && error.startsWith(t('pushError')) ? '' : error;
  const lock = useRef(false);
  const busy = pending || state.busy || state.pushStatus === 'registering';
  const [pushTitle, pushBody] = pushMessages[state.pushStatus];
  const removingPush = state.pushStatus === 'enabled' || state.pushStatus === 'pending-revocation';
  const pushActionDisabled = !state.session || busy || (!removingPush && state.pushStatus === 'unconfigured');
  const pushActionLabel = state.pushStatus === 'pending-revocation' ? 'retryRemoval' : removingPush ? 'disableShort' : 'enableShort';
  async function perform(action: () => Promise<void>, errorKey: MessageKey) {
    if (lock.current || busy) return;
    lock.current = true; setPending(true); setError('');
    try { await action(); } catch (cause) { setError(t(errorKey) + (cause instanceof PushRegistrationError ? ' (' + cause.message + ')' : '')); } finally { lock.current = false; setPending(false); }
  }
  function confirm(kind: 'signOut' | 'switchServer') {
    if (busy) return;
    Alert.alert(t(kind === 'signOut' ? 'signOutTitle' : 'switchServerTitle'), t(kind === 'signOut' ? 'signOutBody' : 'switchServerBody'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t(kind), style: 'destructive', onPress: () => void perform(kind === 'signOut' ? state.signOut : state.disconnect, 'accountError') },
    ]);
  }
  return <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.groupedBackground }}>
    <AppHeader />
    <Stack.Title>{t('settings')}</Stack.Title>
    {!!(visibleError || state.error) && <View style={{ paddingHorizontal: 20, paddingTop: 12 }}><Notice message={visibleError || state.error} /></View>}
    <Host colorScheme={c.dark ? 'dark' : 'light'} seedColor={c.brand} style={{ flex: 1, backgroundColor: c.groupedBackground }}>
      <FieldGroup style={{ backgroundColor: c.groupedBackground }} modifiers={Platform.OS === 'ios' ? [scrollContentBackground('hidden')] : undefined}>
        <FieldGroup.Section modifiers={rowModifiers} title={t('server')}><ListItem colors={rowColors}><Column spacing={4}><NativeText textStyle={{ color: c.muted, fontSize: 13 }}>{t('serverUrl')}</NativeText><NativeText textStyle={{ color: c.text, fontSize: 17 }}>{state.serverUrl}</NativeText></Column></ListItem></FieldGroup.Section>
        <FieldGroup.Section modifiers={rowModifiers} title={t('account')}>
          <ListItem colors={rowColors}><Column spacing={4}><NativeText textStyle={{ color: c.text, fontSize: 17 }}>{hasAccountName ? accountName : accountEmail || t('unavailable')}</NativeText>{hasAccountName && !!accountEmail && <NativeText textStyle={{ color: c.muted, fontSize: 15 }}>{accountEmail}</NativeText>}{!!accountRole && <NativeText textStyle={{ color: c.muted, fontSize: 15 }}>{accountRole}</NativeText>}</Column></ListItem>
        </FieldGroup.Section>
        <FieldGroup.Section modifiers={rowModifiers} title={t('connections')}>
          {neutralAction(<Button label={t('manageConnections')} variant="text" disabled={busy} onPress={() => router.push('/connections')} />)}
          {!state.session && neutralAction(<Button label={t('signIn')} variant="text" disabled={busy} onPress={() => router.push('/connect')} />)}
        </FieldGroup.Section>
        {state.organizations.length > 0 && <FieldGroup.Section modifiers={rowModifiers} title={t('allOrganizations')}>{state.organizations.map(org => <ListItem key={org.id} colors={rowColors}><NativeText>{org.name}</NativeText></ListItem>)}</FieldGroup.Section>}
        <FieldGroup.Section modifiers={rowModifiers} title={t('notifications')}>
          <ListItem colors={rowColors} trailing={<Button disabled={pushActionDisabled} variant="text" onPress={() => void perform(removingPush ? state.disablePush : state.registerPush, 'pushError')}><NativeText textStyle={{ color: pushActionDisabled ? c.muted : Platform.OS === 'ios' ? c.dark ? '#0a84ff' : '#007aff' : c.brand }}>{t(pushActionLabel)}</NativeText></Button>}><NativeText>{t('notifications')}</NativeText></ListItem>
          <ListItem colors={rowColors}><NativeText textStyle={{ color: c.muted, fontSize: 17 }}>{t(pushTitle) + ' ' + t(pushBody)}</NativeText></ListItem>
        </FieldGroup.Section>
        <FieldGroup.Section modifiers={rowModifiers} title={t('support')}>
          {neutralAction(<Button label={t('support')} variant="text" onPress={() => void perform(() => Linking.openURL('https://i7y.devi.tools/support').then(() => undefined), 'linkError')} />)}
          {neutralAction(<Button label={t('privacyPolicy')} variant="text" onPress={() => void perform(() => Linking.openURL('https://i7y.devi.tools/privacy').then(() => undefined), 'linkError')} />)}
        </FieldGroup.Section>
        <FieldGroup.Section modifiers={rowModifiers}>
          {neutralAction(<Button label={t('signOut')} disabled={busy} variant="text" onPress={() => confirm('signOut')} />)}
          {neutralAction(<Button label={t('addConnection')} disabled={busy} variant="text" onPress={() => router.push({ pathname: '/connect', params: { add: '1' } })} />)}
        </FieldGroup.Section>
      </FieldGroup>
    </Host>
  </SafeAreaView>;
}
