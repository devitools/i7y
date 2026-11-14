import { Button, Column, FieldGroup, Host, ListItem, Text, TextInput, useNativeState } from '@expo/ui';
import { listRowBackground, scrollContentBackground } from '@expo/ui/swift-ui/modifiers';
import { useState } from 'react';
import { Alert, Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Stack } from 'expo-router/stack';
import { Notice } from '@/components/ui';
import type { MobileConnection } from '@/core/connections';
import { t } from '@/locales';
import { useI7y } from '@/state/session';
import { useTheme } from '@/theme/colors';

function ConnectionSection({ connection, pending, perform }: { connection: MobileConnection; pending: boolean; perform: (action: () => Promise<void>) => void }) {
  const c = useTheme();
  const state = useI7y();
  const router = useRouter();
  const name = useNativeState(connection.profile.name);
  const colors = { containerColor: c.surface, contentColor: c.text, supportingContentColor: c.muted };
  const active = state.activeId === connection.profile.id;
  const row = (button: React.ReactElement) => Platform.OS === 'android' ? <ListItem colors={colors}>{button}</ListItem> : button;
  function remove() {
    Alert.alert(t('removeConnection'), t('removeConnectionBody'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('remove'), style: 'destructive', onPress: () => perform(() => state.removeConnection(connection.profile.id)) },
    ]);
  }
  return <FieldGroup.Section title={connection.profile.name} modifiers={Platform.OS === 'ios' ? [listRowBackground(c.surface)] : undefined}>
    <ListItem colors={colors}><Column spacing={4}>
      <Text textStyle={{ color: c.text, fontSize: 17 }}>{connection.profile.serverUrl}</Text>
      <Text textStyle={{ color: c.muted, fontSize: 14 }}>{connection.session?.record.email ?? t('signedOut')}</Text>
      {!!connection.error && <Text textStyle={{ color: c.muted, fontSize: 14 }}>{t('connectionUnavailable')}</Text>}
    </Column></ListItem>
    <ListItem colors={colors}><TextInput value={name} placeholder={t('connectionName')} maxLength={80} editable={!pending} autoCorrect={false} textStyle={{ color: c.text, fontSize: 17 }} /></ListItem>
    {row(<Button label={t('saveName')} variant="text" disabled={pending} onPress={() => perform(() => state.renameConnection(connection.profile.id, name.get()))} />)}
    {row(<Button label={t(active ? 'selectedConnection' : 'selectConnection')} variant="text" disabled={pending || active} onPress={() => state.selectConnection(connection.profile.id)} />)}
    {row(<Button label={t(connection.session ? 'signOut' : 'signIn')} variant="text" disabled={pending} onPress={() => {
      state.selectConnection(connection.profile.id);
      if (connection.session) perform(state.signOut);
      else router.push('/connect');
    }} />)}
    {row(<Button label={t('removeConnection')} variant="text" disabled={pending} onPress={remove} />)}
  </FieldGroup.Section>;
}
export default function ConnectionsScreen() {
  const c = useTheme();
  const state = useI7y();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function perform(action: () => Promise<void>) {
    if (pending || state.busy) return;
    setPending(true); setError('');
    try { await action(); } catch { setError(t('accountError')); } finally { setPending(false); }
  }
  const busy = pending || state.busy;
  const colors = { containerColor: c.surface, contentColor: c.text };
  const add = <Button label={t('addConnection')} variant="text" disabled={busy} onPress={() => router.push({ pathname: '/connect', params: { add: '1' } })} />;
  return <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: c.groupedBackground }}>
    <Stack.Title>{t('connections')}</Stack.Title>
    {!!error && <View style={{ padding: 16 }}><Notice message={error} /></View>}
    <Host colorScheme={c.dark ? 'dark' : 'light'} seedColor={c.brand} style={{ flex: 1 }}>
      <FieldGroup modifiers={Platform.OS === 'ios' ? [scrollContentBackground('hidden')] : undefined}>
        <FieldGroup.Section><ListItem colors={colors}><Text textStyle={{ color: c.muted, fontSize: 15 }}>{t('connectionsBody')}</Text></ListItem>{Platform.OS === 'android' ? <ListItem colors={colors}>{add}</ListItem> : add}</FieldGroup.Section>
        {state.connections.map(connection => <ConnectionSection key={connection.profile.id} connection={connection} pending={busy} perform={action => { void perform(action); }} />)}
      </FieldGroup>
    </Host>
  </SafeAreaView>;
}
