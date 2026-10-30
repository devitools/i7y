import { Button, Host, Picker } from '@expo/ui';
import { useEffect, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Platform, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { locale, t } from '@/locales';
import { incidentTimestamp } from '@/core/client';
import { useTheme } from '@/theme/colors';

export function Copy({ children, muted = false, size = 16, weight = '400' }: { children: ReactNode; muted?: boolean; size?: number; weight?: '400' | '500' | '600' | '700' }) {
  const c = useTheme();
  return <Text selectable style={{ color: muted ? c.muted : c.text, fontSize: size, lineHeight: size * 1.45, fontWeight: weight }}>{children}</Text>;
}
export function Section({ title, children }: { title?: string; children: ReactNode }) {
  const c = useTheme();
  return <View style={{ gap: 10 }}>{title && <Copy size={13} muted weight="600">{title}</Copy>}<View style={{ backgroundColor: c.surface, padding: 18, gap: 14, borderRadius: 18, borderCurve: 'continuous' }}>{children}</View></View>;
}
export function Action({ label, onPress, busy = false, disabled = false, secondary = false }: { label: string; onPress: () => void; busy?: boolean; disabled?: boolean; secondary?: boolean }) {
  return <View style={{ gap: 8 }}>{busy && <ActivityIndicator color="#4f46e5" accessibilityLabel={t('working')} />}<Host matchContents seedColor="#4f46e5"><Button label={busy ? t('working') : label} onPress={onPress} disabled={busy || disabled} variant={secondary ? 'outlined' : 'filled'} style={{ width: '100%', paddingVertical: 6 }} /></Host></View>;
}
export function Field({ label, value, onChangeText, keyboardType, placeholder, disabled = false }: { label: string; value: string; onChangeText: (value: string) => void; keyboardType?: KeyboardTypeOptions; placeholder?: string; disabled?: boolean }) {
  const c = useTheme();
  return <View style={{ gap: 8 }} accessibilityLabel={label}><Copy size={13} muted weight="600">{label}</Copy><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder ?? label} placeholderTextColor={c.muted} keyboardType={keyboardType} editable={!disabled} autoCapitalize="none" autoCorrect={false} style={{ fontSize: 17, color: c.fieldText, backgroundColor: c.fieldSurface, paddingHorizontal: 16, paddingVertical: 14, minHeight: 50, borderRadius: 16, width: '100%' }} /></View>;
}
export function Select({ label, value, items, onChange, disabled = false }: { label: string; value: string; items: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <View style={{ gap: 4 }} accessibilityLabel={label}><Copy size={13} muted weight="600">{label}</Copy><Host matchContents seedColor="#4f46e5"><Picker selectedValue={value} onValueChange={onChange} enabled={!disabled}>{items.map(item => <Picker.Item key={item.value} value={item.value} label={item.label} />)}</Picker></Host></View>;
}
export function Notice({ message, retry }: { message: string; retry?: () => void }) {
  const c = useTheme();
  return <View accessibilityLiveRegion="polite" style={{ borderLeftWidth: 3, borderLeftColor: c.brand, padding: 14, gap: 10, backgroundColor: c.surface, borderRadius: 10 }}><Copy size={14}>{message}</Copy>{retry && <Action label={t('retry')} secondary onPress={retry} />}</View>;
}
export function Empty({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return <View style={{ paddingVertical: 36, gap: 12 }}><Copy size={24} weight="600">{title}</Copy>{body && <Copy muted>{body}</Copy>}{children}</View>;
}
export function Loading() {
  return <View style={{ padding: 48, gap: 12 }}><ActivityIndicator color="#4f46e5" /><Copy muted>{t('loading')}</Copy></View>;
}
export function Fact({ label, value }: { label: string; value: string }) {
  return <View style={{ gap: 3 }}><Copy size={12} muted>{label}</Copy><Copy>{value || '—'}</Copy></View>;
}
export function formatDate(value: string | number) {
  const time = typeof value === 'number' ? value : incidentTimestamp(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}
export function useForegroundRefresh(refresh: () => unknown) {
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => subscription.remove();
  }, [refresh]);
}
export const screenContent = { padding: 20, gap: 24, paddingBottom: Platform.OS === 'ios' ? 40 : 28 };
