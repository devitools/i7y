import { MenuView } from '@expo/ui/community/menu';
import { Image } from 'expo-image';
import { Pressable, Text, View } from 'react-native';
import { t, type Locale } from '@/locales';
import { useAppearance } from '@/state/appearance';
import { useTheme } from '@/theme/colors';

const languages: { id: Locale; title: string }[] = [{ id: 'en', title: 'EN' }, { id: 'pt-BR', title: 'PT' }, { id: 'uk', title: 'UK' }];

export function AppHeader() {
  const c = useTheme();
  const appearance = useAppearance();
  return <View style={{ minHeight: 56, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.separator }}>
    <Image source={require('@/assets/brand.svg')} style={{ width: 32, height: 32, marginRight: 10 }} accessibilityLabel="i7y" />
    <Text style={{ fontWeight: '700', fontSize: 22, color: c.text, flex: 1 }}>i7y</Text>
    <MenuView title={t('language')} colorScheme={appearance.theme} style={{ width: 76, height: 44 }} actions={languages.map(language => ({ ...language, state: appearance.language === language.id ? 'on' : 'off' }))} onPressAction={({ nativeEvent }) => { const selected = languages.find(language => language.id === nativeEvent.event); if (selected) appearance.setLanguage(selected.id); }}>
      <View accessible accessibilityRole="button" accessibilityLabel={t('language')} accessibilityValue={{ text: languages.find(language => language.id === appearance.language)?.title }} style={{ width: 76, height: 44, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: c.text, fontSize: 14 }}>{languages.find(language => language.id === appearance.language)?.title}</Text><Text style={{ color: c.muted, fontSize: 12 }}>⌄</Text></View>
    </MenuView>
    <Pressable accessibilityRole="button" accessibilityLabel={t('toggleTheme')} onPress={appearance.toggleTheme} hitSlop={8} style={{ width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 25, color: c.text }}>{c.dark ? '☼' : '☾'}</Text></Pressable>
  </View>;
}
