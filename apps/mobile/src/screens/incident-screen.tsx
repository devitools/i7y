import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, AppState, KeyboardAvoidingView, Platform, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Stack } from 'expo-router/stack';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Action, Copy, Empty, Fact, Field, Loading, Notice, Section, Select, formatDate, screenContent, useForegroundRefresh } from '@/components/ui';
import { ApiError, ContextChangedError, incidentPhase, incidentTimestamp } from '@/core/client';
import type { Incident } from '@/core/types';
import { t } from '@/locales';
import { useI7y } from '@/state/session';
import { useTheme } from '@/theme/colors';

export default function IncidentScreen() {
  const c = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, queryKey, organizationId, organization, session } = useI7y();
  const cache = useQueryClient();
  const key = [...queryKey, 'incident', id];
  const context = JSON.stringify(key);
  const activeContext = useRef(context);
  useLayoutEffect(() => { activeContext.current = context; return () => { activeContext.current = ''; }; }, [context]);
  const [duration, setDuration] = useState('30');
  const [custom, setCustom] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [operation, setOperation] = useState<{ context: string; kind: 'claim' | 'resolve' } | null>(null);
  const [notice, setNotice] = useState<{ context: string; text: string } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const submitting = useRef(false);
  const query = useQuery({ queryKey: key, enabled: !!organizationId && !!id && !!session, queryFn: () => api.incident(id) });
  const incident = query.data;
  const { refetch } = query;
  const busy = operation?.context === context;
  const needsConfirmation = blocked === context;
  const refresh = useCallback(async () => {
    if (!organizationId || !id) return;
    const result = await refetch();
    if (activeContext.current === context && result.isSuccess) {
      setBlocked(previous => previous === context ? null : previous);
      setNotice(previous => previous?.context === context && previous.text === t('uncertain') ? { context, text: t('confirmed') } : previous);
    }
  }, [organizationId, id, refetch, context]);
  useForegroundRefresh(refresh);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer); }, []);
  const minutes = Number(duration === 'custom' ? custom : duration);
  const base = incident && incident.assignee === session?.record.id ? Math.max(now, incidentTimestamp(incident.claim_until) || now) : now;
  const nextDeadline = base + minutes * 60000;
  const validDuration = /^\d+$/.test(duration === 'custom' ? custom : duration) && Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 10080 && nextDeadline <= now + 10080 * 60000;
  const phase = incident ? incidentPhase(incident, now) : 'open';
  const canWrite = !!organization && organization.role !== 'reader';
  const ownedByOther = !!incident?.assignee && incident.assignee !== session?.record.id && phase === 'inProgress';
  async function act(kind: 'claim' | 'resolve') {
    if (submitting.current || busy || needsConfirmation || !incident || incident.status === 'resolved' || !canWrite || (AppState.currentState !== null && AppState.currentState !== 'active')) return;
    const actionTime = Date.now();
    const actionBase = incident.assignee === session?.record.id ? Math.max(actionTime, incidentTimestamp(incident.claim_until) || actionTime) : actionTime;
    const actionDeadline = actionBase + minutes * 60000;
    if (kind === 'claim' && (ownedByOther || !validDuration || actionDeadline > actionTime + 10080 * 60000)) return;
    submitting.current = true;
    const requestContext = context;
    setOperation({ context, kind }); setNotice(null);
    try {
      const result = kind === 'claim' ? await api.claim(id, new Date(actionDeadline).toISOString(), incident.version) : await api.resolve(id, incident.version);
      cache.setQueryData<Incident>(key, result);
      await cache.invalidateQueries({ queryKey: [...queryKey, 'incidents'] });
      await cache.invalidateQueries({ queryKey: key });
    } catch (error) {
      if (activeContext.current !== requestContext || error instanceof ContextChangedError) return;
      const conflict = error instanceof ApiError && error.status === 409;
      const ambiguous = !(error instanceof ApiError) || error.status >= 500 || error.status === 408;
      setNotice({ context, text: t(conflict ? 'conflict' : ambiguous ? 'uncertain' : 'actionError') });
      if (conflict || ambiguous) {
        setBlocked(context);
        await cache.invalidateQueries({ queryKey: [...queryKey, 'incidents'] });
        await refresh();
      }
    } finally {
      submitting.current = false;
      if (activeContext.current === requestContext) setOperation(null);
    }
  }
  const latestAction = useRef(act);
  useLayoutEffect(() => { latestAction.current = act; });
  function confirmResolve() {
    if (busy || needsConfirmation || submitting.current) return;
    Alert.alert(t('resolveTitle'), t(incident?.origin === 'rule' ? 'resolveRuleBody' : 'resolveBody'), [{ text: t('cancel'), style: 'cancel' }, { text: t('resolve'), onPress: () => { if (activeContext.current === context) void latestAction.current('resolve'); } }]);
  }
  return <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: c.background }}>
    <Stack.Title>{t('incident')}</Stack.Title>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={screenContent} refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => void refresh()} tintColor={c.brand} />}>
        {!organizationId ? <Empty title={t('noOrganizations')} body={t('noOrganizationsBody')} /> : !incident ? query.error || query.fetchStatus === 'paused' ? <Empty title={t('noIncident')} body={t('noIncidentBody')}><Notice message={t('requestError')} retry={() => void refresh()} /></Empty> : <Loading /> : <>
          <View style={{ gap: 10 }}><Copy size={13} weight="600">{t(incident.severity) + ' · ' + t(phase)}</Copy><Copy size={28} weight="600">{incident.title}</Copy><Copy muted>{incident.resource_name || incident.resource_id}</Copy>{incident.assignee === session?.record.id && <Copy size={13} weight="600">{t('mine')}</Copy>}</View>
          {query.error && <Notice message={t('refreshError')} retry={() => void refresh()} />}
          {notice?.context === context && <Notice message={notice.text} retry={needsConfirmation ? () => void refresh() : undefined} />}
          <Section title={t('details')}>
            <Fact label={t('resource')} value={incident.resource_name || incident.resource_id} /><Fact label={t('origin')} value={incident.origin} /><Fact label={t('opened')} value={formatDate(incident.opened_at)} />
            <Fact label={t('assignee')} value={incident.assignee || t('unassigned')} />
            {!!incident.assignee && <Fact label={t('deadline')} value={formatDate(incident.claim_until)} />}
            {incident.status === 'resolved' && <><Fact label={t('resolvedAt')} value={formatDate(incident.resolved_at)} /><Fact label={t('resolutionReason')} value={incident.resolution_reason} /></>}
          </Section>
          {incident.status !== 'resolved' && <Section title={t('response')}>
            {!canWrite ? <Copy muted>{t('reader')}</Copy> : <>
              {ownedByOther ? <Copy muted>{t('otherOwner')}</Copy> : <>
                <Copy muted>{t('claimBody')}</Copy>
                <Select label={t('deadline')} value={duration} disabled={busy || needsConfirmation} onChange={setDuration} items={[15, 30, 60, 120].map(value => ({ value: String(value), label: t('minutes', { count: value }) })).concat({ value: 'custom', label: t('custom') })} />
                {duration === 'custom' && <Field label={t('customMinutes')} value={custom} onChangeText={setCustom} keyboardType="number-pad" disabled={busy || needsConfirmation} />}
                <Copy size={13} muted>{validDuration ? t('deadlinePreview', { date: formatDate(nextDeadline) }) : t('invalidMinutes')}</Copy>
                <Action label={t(incident.assignee === session?.record.id ? 'extend' : 'claim')} onPress={() => void act('claim')} busy={busy && operation?.kind === 'claim'} disabled={busy || needsConfirmation || !validDuration} />
              </>}
              <Action label={t('resolve')} secondary onPress={confirmResolve} busy={busy && operation?.kind === 'resolve'} disabled={busy || needsConfirmation} />
            </>}
          </Section>}
          <Section title={t('evidence')}>{Object.keys(incident.evidence ?? {}).length ? <Text selectable style={{ color: c.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 20 }}>{JSON.stringify(incident.evidence, null, 2)}</Text> : <Copy muted>{t('noEvidence')}</Copy>}</Section>
          <Section title={t('timeline')}>
            {(incident.events ?? []).length ? incident.events?.map(event => <View key={event.id} style={{ gap: 5, paddingVertical: 8 }}><Copy weight="600">{eventLabel(event.kind)}</Copy><Copy muted size={13}>{formatDate(event.occurred_at)}</Copy>{!!event.actor && <Copy size={13}>{event.actor}</Copy>}{Object.keys(event.data ?? {}).length > 0 && <Text selectable style={{ color: c.muted, fontSize: 12, lineHeight: 18 }}>{JSON.stringify(event.data, null, 2)}</Text>}</View>) : <Copy muted>{t('noEvents')}</Copy>}
          </Section>
        </>}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
function eventLabel(kind: string) {
  if (/open|creat/i.test(kind)) return t('eventOpened');
  if (/resolv/i.test(kind)) return t('eventResolved');
  if (/extend/i.test(kind)) return t('eventExtended');
  if (/claim/i.test(kind)) return t('eventClaimed');
  return t('eventUpdated');
}
