import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'invenioscan.token';
const BASE_URL_KEY = 'invenioscan.baseUrl';

export async function saveSession(token: string, baseUrl: string) {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  await SecureStore.setItemAsync(BASE_URL_KEY, baseUrl);
}

export async function clearSession() {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(BASE_URL_KEY);
}

export async function loadSession() {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  const baseUrl = await SecureStore.getItemAsync(BASE_URL_KEY);

  if (!token || !baseUrl) {
    return null;
  }

  return { token, baseUrl };
}