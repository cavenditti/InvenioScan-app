import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const TOKEN_KEY = 'invenioscan.token';
const BASE_URL_KEY = 'invenioscan.baseUrl';
const USERNAME_KEY = 'invenioscan.username';

function getWebStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export async function saveSession(token: string, baseUrl: string, username?: string) {
  if (Platform.OS === 'web') {
    const storage = getWebStorage();
    if (!storage) {
      return;
    }

    storage.setItem(TOKEN_KEY, token);
    storage.setItem(BASE_URL_KEY, baseUrl);
    if (username) {
      storage.setItem(USERNAME_KEY, username);
    }
    return;
  }

  await SecureStore.setItemAsync(TOKEN_KEY, token);
  await SecureStore.setItemAsync(BASE_URL_KEY, baseUrl);
  if (username) {
    await SecureStore.setItemAsync(USERNAME_KEY, username);
  }
}

export async function clearSession() {
  if (Platform.OS === 'web') {
    const storage = getWebStorage();
    if (!storage) {
      return;
    }

    storage.removeItem(TOKEN_KEY);
    storage.removeItem(BASE_URL_KEY);
    storage.removeItem(USERNAME_KEY);
    return;
  }

  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(BASE_URL_KEY);
  await SecureStore.deleteItemAsync(USERNAME_KEY);
}

export async function loadSession() {
  let token: string | null = null;
  let baseUrl: string | null = null;
  let username: string | null = null;

  if (Platform.OS === 'web') {
    const storage = getWebStorage();
    if (!storage) {
      return null;
    }

    token = storage.getItem(TOKEN_KEY);
    baseUrl = storage.getItem(BASE_URL_KEY);
    username = storage.getItem(USERNAME_KEY);
  } else {
    token = await SecureStore.getItemAsync(TOKEN_KEY);
    baseUrl = await SecureStore.getItemAsync(BASE_URL_KEY);
    username = await SecureStore.getItemAsync(USERNAME_KEY);
  }

  if (!token || !baseUrl) {
    return null;
  }

  return { token, baseUrl, username };
}