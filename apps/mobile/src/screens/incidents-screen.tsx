import { AppHeader } from '@/components/app-header';
import { Image } from 'expo-image';
import { MenuView } from '@expo/ui/community/menu';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Platform, Pressable, RefreshControl, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Link, useFocusEffect } from 'expo-router';
import { Stack } from 'expo-router/stack';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Action, Copy, Empty, Loading, Notice, formatDate, useForegroundRefresh } from '@/components/ui';
import { incidentPhase } from '@/core/client';
import type { Incident } from '@/core/types';
import { t, type MessageKey } from '@/locales';
import { useI7y } from '@/state/session';
import { useTheme } from '@/theme/colors';

function Glyph({ kind, color, size = 20 }: { kind: 'search' | 'alert' | 'chevron' | 'down'; color: string; size?: number }) {
  const sources = { search: require('@/assets/icons/search.svg'), alert: require('@/assets/icons/alert.svg'), chevron: require('@/assets/icons/chevron.svg'), down: require('@/assets/icons/down.svg') };
  return <Image accessible={false} source={sources[kind]} tintColor={color} style={{ width: size, height: size }} />;
}
function IncidentRow({ incident, userId, now, first, last }: { incident: Incident; userId?: string; now: number; first: boolean; last: boolean }) {
  const c = useTheme();
  const severity = c[incident.severity];
  return <Link href={{ pathname: '/incident/[id]', params: { id: incident.id } }} asChild>
    <Pressable accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 16, gap: 14, backgroundColor: c.surface, borderTopLeftRadius: first ? 24 : 0, borderTopRightRadius: first ? 24 : 0, borderBottomLeftRadius: last ? 24 : 0, borderBottomRightRadius: last ? 24 : 0, borderCurve: 'continuous' }}>
      <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: severity + '20', alignItems: 'center', justifyContent: 'center' }}><Glyph kind="alert" color={severity} size={24} /></View>
      <View style={{ flex: 1, gap: 3 }}>
        <Copy size={17} weight="600">{incident.title}</Copy>
        <Copy size={15} muted>{incident.resource_name || incident.resource_id}</Copy>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: severity }} /><Copy size={12} muted>{t(incident.severity) + ' · ' + t(incidentPhase(incident, now))}</Copy>{incident.assignee === userId && <Copy size={12} weight="600">{t('mine')}</Copy>}</View>
        {!!incident.assignee && incident.status !== 'resolved' && <Copy size={12} muted>{t('deadline') + ': ' + formatDate(incident.claim_until)}</Copy>}
      </View>
      <Glyph kind="chevron" color={c.muted} size={22} />
    </Pressable>
  </Link>;
}
export default function IncidentsScreen() {
  const c = useTheme();
  const { api, queryKey, organizationId, session } = useI7y();
  const [status, setStatus] = useState('open');
  const [severity, setSeverity] = useState('all');
  const [search, setSearch] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timeout = setTimeout(() => setSearchQuery(search.trim()), 350); return () => clearTimeout(timeout); }, [search]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const filters = { status, severity: severity === 'all' ? undefined : severity, search: searchQuery };
  const query = useInfiniteQuery({
    queryKey: [...queryKey, 'incidents', filters], enabled: !!organizationId && !!session,
    initialPageParam: 1, queryFn: ({ pageParam }) => api.incidents({ ...filters, page: pageParam, perPage: 30 }),
    getNextPageParam: page => page.page < page.totalPages ? page.page + 1 : undefined,
  });
  const { refetch } = query;
  const refresh = useCallback(() => { if (organizationId) void refetch(); }, [organizationId, refetch]);
  useForegroundRefresh(refresh);
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  const items = [...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()];
  function reset() { setStatus('open'); setSeverity('all'); setSearch(''); setSearchQuery(''); }
  function filterMenu(label: string, value: string, values: string[], onChange: (value: string) => void) {
    return <MenuView title={label} colorScheme={c.dark ? 'dark' : 'light'} actions={values.map(id => ({ id, title: t(id as MessageKey), state: id === value ? 'on' : 'off' }))} onPressAction={({ nativeEvent }) => onChange(nativeEvent.event)}>
      <View accessible accessibilityRole="button" accessibilityLabel={label} accessibilityValue={{ text: t(value as MessageKey) }} style={{ minHeight: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}><Copy size={14} weight="600">{t(value as MessageKey)}</Copy><Glyph kind="down" color={c.muted} size={20} /></View>
    </MenuView>;
  }
  const header = <View style={{ paddingBottom: 12, gap: 12 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 }}><Copy size={28} weight="700">{t('incidents')}</Copy><View style={{ minWidth: 26, height: 26, paddingHorizontal: 8, borderRadius: 13, backgroundColor: c.badgeSurface, alignItems: 'center', justifyContent: 'center' }}><Copy size={13} muted weight="600">{query.data?.pages[0]?.totalItems ?? items.length}</Copy></View></View>
    {!!organizationId && <>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.fieldSurface, borderRadius: 16, paddingHorizontal: 16, minHeight: 50 }}>
        <Glyph kind="search" color={c.muted} size={20} /><TextInput accessibilityLabel={t('search')} placeholder={t('search')} placeholderTextColor={c.muted} value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false} returnKeyType="search" style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 12, fontSize: 17, color: c.text }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: c.surface, borderRadius: 16, paddingHorizontal: 4 }}>
        {filterMenu(t('status'), status, ['open', 'resolved', 'all'], setStatus)}
        {filterMenu(t('severity'), severity, ['all', 'critical', 'warning', 'info'], setSeverity)}
      </View>
      {query.error && query.data && <Notice message={t('refreshError')} retry={refresh} />}
    </>}
  </View>;
  return <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.groupedBackground }}>
    <AppHeader />
    <Stack.Title>{t('incidents')}</Stack.Title>
    <FlatList data={items} keyExtractor={item => item.id} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, flexGrow: 1 }}
      ListHeaderComponent={header} ItemSeparatorComponent={() => <View style={{ height: Platform.OS === 'ios' ? 0.5 : 3, backgroundColor: c.separator, marginLeft: Platform.OS === 'ios' ? 78 : 0, marginRight: 16 }} />}
      renderItem={({ item, index }) => <IncidentRow incident={item} userId={session?.record.id} now={now} first={index === 0} last={index === items.length - 1} />}
      refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={refresh} tintColor={c.brand} />}
      ListEmptyComponent={!organizationId ? <Empty title={t('noOrganizations')} body={t('noOrganizationsBody')} /> : !query.data ? query.error || query.fetchStatus === 'paused' ? <Notice message={t('requestError')} retry={refresh} /> : <Loading /> : <Empty title={t('empty')} body={t('emptyBody')}><Action label={t('clearFilters')} secondary onPress={reset} /></Empty>}
      ListFooterComponent={query.hasNextPage ? <View style={{ paddingVertical: 20 }}><Action label={t('more')} secondary busy={query.isFetchingNextPage} onPress={() => { if (!query.isFetching) void query.fetchNextPage(); }} /></View> : undefined}
    />
  </SafeAreaView>;
}
