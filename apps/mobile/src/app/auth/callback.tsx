import { Redirect } from 'expo-router';
import { useI7y } from '@/state/session';

export default function AuthCallback() {
  const { hasSessions, busy } = useI7y();
  if (busy) return null;
  return <Redirect href={hasSessions ? '/' : '/connect'} />;
}
