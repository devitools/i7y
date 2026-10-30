import { NativeTabs } from 'expo-router/native-tabs';
import { t, useLocale } from '@/locales';

export default function TabsLayout() {
  useLocale();
  return <NativeTabs tintColor="#4f46e5">
    <NativeTabs.Trigger name="index">
      <NativeTabs.Trigger.Icon sf="exclamationmark.bubble.fill" md="crisis_alert" />
      <NativeTabs.Trigger.Label>{t('incidents')}</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="settings">
      <NativeTabs.Trigger.Icon sf="gearshape.fill" md="settings" />
      <NativeTabs.Trigger.Label>{t('settings')}</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
  </NativeTabs>;
}
