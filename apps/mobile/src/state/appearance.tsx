import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';
import { Appearance, useColorScheme } from 'react-native';
import { locale, selectLocale, useLocale, type Locale } from '@/locales';

type Theme = 'light' | 'dark';
type AppearanceState = { theme: Theme; language: Locale; toggleTheme: () => void; setLanguage: (value: Locale) => void };
const Context = createContext<AppearanceState | null>(null);
const key = 'i7y.mobile.appearance';

export function AppearanceProvider({ children }: PropsWithChildren) {
  const system = useColorScheme();
  const [theme, setTheme] = useState<Theme>(system === 'dark' ? 'dark' : 'light');
  const language = useLocale();
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(key).then(value => {
      if (!active || !value) return;
      const saved = JSON.parse(value);
      if (saved.theme === 'dark' || saved.theme === 'light') setTheme(saved.theme);
      if (['en', 'pt-BR', 'uk'].includes(saved.language)) selectLocale(saved.language);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => { Appearance.setColorScheme(theme); }, [theme]);
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    void AsyncStorage.setItem(key, JSON.stringify({ theme: next, language: locale() })).catch(() => {});
  }
  function setLanguage(value: Locale) {
    selectLocale(value);
    void AsyncStorage.setItem(key, JSON.stringify({ theme, language: value })).catch(() => {});
  }
  return <Context.Provider value={{ theme, language, toggleTheme, setLanguage }}>{children}</Context.Provider>;
}

export function useAppearance() {
  const value = useContext(Context);
  if (!value) throw new Error('AppearanceProvider is required');
  return value;
}
