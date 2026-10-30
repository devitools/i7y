import { MenuView } from '@expo/ui/community/menu';
import { Image } from 'expo-image';
import { listRowBackground, scrollContentBackground } from '@expo/ui/swift-ui/modifiers';
import { Button, Column, FieldGroup, Host, ListItem, Picker, RNHostView, Text as NativeText } from '@expo/ui';
import { useRef, useState, type ReactElement } from 'react';
import { Alert, Platform, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router/stack';
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
  const pushActionDisabled = busy || (!removingPush && state.pushStatus === 'unconfigured');
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
        {state.organizations.length > 0 && <FieldGroup.Section modifiers={rowModifiers} title={t('organization')}>{Platform.OS === 'android' ? <ListItem colors={rowColors}><RNHostView matchContents={{ vertical: true }}><MenuView title={t('organization')} colorScheme={c.dark ? 'dark' : 'light'} style={{ width: '100%' }} actions={state.organizations.map(org => ({ id: org.id, title: org.name, state: org.id === state.organizationId ? 'on' : 'off', attributes: { disabled: busy } }))} onPressAction={({ nativeEvent }) => { if (!busy) state.setOrganization(nativeEvent.event); }}><View accessible accessibilityRole="button" accessibilityLabel={t('organization')} accessibilityValue={{ text: state.organization?.name }} style={{ minHeight: 40, paddingHorizontal: 0, flexDirection: 'row', gap: 12, alignItems: 'center', backgroundColor: c.surface, borderRadius: 16 }}><Text style={{ flex: 1, color: c.text, fontSize: 17 }}>{state.organization?.name}</Text><Image source={require('@/assets/icons/down.svg')} tintColor={c.muted} style={{ width: 20, height: 20 }} /></View></MenuView></RNHostView></ListItem> : <Picker selectedValue={state.organizationId ?? ''} onValueChange={state.setOrganization} enabled={!busy}>{state.organizations.map(org => <Picker.Item key={org.id} value={org.id} label={org.name} />)}</Picker>}</FieldGroup.Section>}
        <FieldGroup.Section modifiers={rowModifiers} title={t('notifications')}>
          <ListItem colors={rowColors} trailing={<Button disabled={pushActionDisabled} variant="text" onPress={() => void perform(removingPush ? state.disablePush : state.registerPush, 'pushError')}><NativeText textStyle={{ color: pushActionDisabled ? c.muted : Platform.OS === 'ios' ? c.dark ? '#0a84ff' : '#007aff' : c.brand }}>{t(pushActionLabel)}</NativeText></Button>}><NativeText>{t('notifications')}</NativeText></ListItem>
          <ListItem colors={rowColors}><NativeText textStyle={{ color: c.muted, fontSize: 17 }}>{t(pushTitle) + ' ' + t(pushBody)}</NativeText></ListItem>
        </FieldGroup.Section>
        <FieldGroup.Section modifiers={rowModifiers}>
          {neutralAction(<Button label={t('signOut')} disabled={busy} variant="text" onPress={() => confirm('signOut')} />)}
          {neutralAction(<Button label={t('switchServer')} disabled={busy} variant="text" onPress={() => confirm('switchServer')} />)}
        </FieldGroup.Section>
      </FieldGroup>
    </Host>
  </SafeAreaView>;
}
