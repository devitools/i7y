import Constants from 'expo-constants';

export const allowLocalServers = __DEV__ || Constants.expoConfig?.extra?.buildVariant === 'simulator';
