import palette from '../../../../packages/theme/palette.json';
import { useAppearance } from '@/state/appearance';

export const colors = { brand: palette.brand, critical: palette.critical, warning: palette.warning, info: palette.info };
export function useTheme() {
  const { theme } = useAppearance();
  const dark = theme === 'dark';
  const values = palette[dark ? 'dark' : 'light'];
  return { ...colors, ...values, dark, groupedBackground: values.background, fieldSurface: values.field, badgeSurface: values.badge, fieldText: values.text };
}
