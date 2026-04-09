import { StatusBar } from 'expo-status-bar';
import * as ImageManipulator from 'expo-image-manipulator';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeType } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { login, submitImageIngest, submitIsbnIngest } from './src/api';
import { normalizeScannedIsbn, parseShelfPayload } from './src/scanner';
import { clearSession, loadSession, saveSession } from './src/storage';

type FormState = {
  shelfId: string;
  row: string;
  position: string;
  height: string;
  title: string;
  author: string;
};

const initialFormState: FormState = {
  shelfId: '',
  row: '',
  position: '1',
  height: '1',
  title: '',
  author: '',
};

export default function App() {
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8000');
  const [username, setUsername] = useState('operator');
  const [password, setPassword] = useState('operator');
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Scan a shelf QR code to begin.');
  const [lastResponse, setLastResponse] = useState<string>('');
  const [manualScanValue, setManualScanValue] = useState('');
  const [form, setForm] = useState<FormState>(initialFormState);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width } = useWindowDimensions();
  const isWeb = Platform.OS === 'web';
  const isCompactWebLayout = isWeb && width < 520;

  const shelfReady = Boolean(
    form.shelfId.trim() && form.row.trim() && form.position.trim() && form.height.trim()
  );
  const scannerMode = shelfReady ? 'book' : 'shelf';
  const barcodeTypes: BarcodeType[] = scannerMode === 'shelf'
    ? ['qr']
    : ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39'];
  const cameraModeLabel = scannerMode === 'shelf'
    ? 'Mode: shelf QR'
    : isWeb
      ? 'Mode: ISBN optional, cover capture available'
      : 'Mode: book barcode';

  useEffect(() => {
    async function restoreSession() {
      const session = await loadSession();
      if (session) {
        setToken(session.token);
        setBaseUrl(session.baseUrl);
      }
      setLoading(false);
    }

    restoreSession().catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (token && permission && !permission.granted) {
      requestPermission().catch(() => undefined);
    }
  }, [permission, requestPermission, token]);

  useEffect(() => {
    return () => {
      if (unlockTimerRef.current) {
        clearTimeout(unlockTimerRef.current);
      }
    };
  }, []);

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function lockScanner(duration = 1200) {
    setScanLocked(true);
    if (unlockTimerRef.current) {
      clearTimeout(unlockTimerRef.current);
    }
    unlockTimerRef.current = setTimeout(() => setScanLocked(false), duration);
  }

  function buildShelfPayload() {
    const position = Number.parseInt(form.position, 10);
    const height = Number.parseInt(form.height, 10);
    if (!form.shelfId.trim() || !form.row.trim() || Number.isNaN(position) || Number.isNaN(height)) {
      return null;
    }

    return {
      shelf_id: form.shelfId.trim(),
      row: form.row.trim(),
      position,
      height,
    };
  }

  function resetBookMetadata() {
    setForm((current) => ({
      ...current,
      title: '',
      author: '',
    }));
  }

  async function handleLogin() {
    try {
      setLoading(true);
      const normalizedBaseUrl = baseUrl.trim();
      const normalizedUsername = username.trim();
      const session = await login(normalizedBaseUrl, normalizedUsername, password);
      setToken(session.access_token);
      setBaseUrl(normalizedBaseUrl);
      setStatusMessage('Scan a shelf QR code to begin.');

      saveSession(session.access_token, normalizedBaseUrl).catch(() => undefined);
    } catch (error) {
      Alert.alert('Login failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await clearSession();
    setToken(null);
    setLastResponse('');
    setForm(initialFormState);
    setStatusMessage('Scan a shelf QR code to begin.');
  }

  async function submitIsbn(isbn: string) {
    if (!token) {
      return;
    }

    const shelf = buildShelfPayload();
    if (!shelf) {
      Alert.alert('Missing shelf', 'Scan or fill in the shelf details first.');
      return;
    }

    try {
      setSubmitting(true);
      const response = await submitIsbnIngest(baseUrl.trim(), token, {
        shelf,
        isbn,
        title: form.title.trim() || undefined,
        author: form.author.trim() || undefined,
      });
      setLastResponse(JSON.stringify(response, null, 2));
      setStatusMessage(`Queued barcode ${isbn}`);
      resetBookMetadata();
    } catch (error) {
      Alert.alert('ISBN ingest failed', error instanceof Error ? error.message : 'Unknown error');
      setStatusMessage('ISBN ingest failed.');
    } finally {
      setSubmitting(false);
      lockScanner();
    }
  }

  async function handleCaptureCover() {
    if (!cameraRef.current || !token) {
      return;
    }

    const shelf = buildShelfPayload();
    if (!shelf) {
      Alert.alert('Missing shelf', 'Scan or fill in the shelf details first.');
      return;
    }

    try {
      setSubmitting(true);
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8, skipProcessing: false });
      if (!photo?.uri) {
        throw new Error('Camera did not return an image.');
      }

      const manipulated = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1200 } }],
        { compress: 0.72, format: ImageManipulator.SaveFormat.JPEG }
      );

      const response = await submitImageIngest(baseUrl.trim(), token, {
        shelf,
        imageUri: manipulated.uri,
        title: form.title.trim() || undefined,
        author: form.author.trim() || undefined,
        mimeType: 'image/jpeg',
        fileName: `cover-${Date.now()}.jpg`,
      });

      setLastResponse(JSON.stringify(response, null, 2));
      setStatusMessage('Queued cover image upload. No ISBN required.');
      resetBookMetadata();
    } catch (error) {
      Alert.alert('Image ingest failed', error instanceof Error ? error.message : 'Unknown error');
      setStatusMessage('Image ingest failed.');
    } finally {
      setSubmitting(false);
      lockScanner(1500);
    }
  }

  async function handleScannedValue(value: string, source: 'camera' | 'manual') {
    if (!token || submitting || (source === 'camera' && scanLocked)) {
      return;
    }

    const scannedValue = value.trim();
    if (!scannedValue) {
      if (source === 'manual') {
        setStatusMessage(
          scannerMode === 'shelf'
            ? 'Paste a shelf QR payload or fill the shelf fields below.'
            : 'Paste or type an ISBN-10 or ISBN-13 value.'
        );
      }
      return;
    }

    if (scannerMode === 'shelf') {
      const parsedShelf = parseShelfPayload(scannedValue);
      if (source === 'camera') {
        lockScanner();
      }

      if (!parsedShelf) {
        setStatusMessage(
          source === 'manual'
            ? 'Could not parse that shelf QR payload. Paste the full invscan://shelf/... value or fill the shelf fields below.'
            : 'Ignored QR code that is not a Shelfscan shelf tag.'
        );
        return;
      }

      setForm((current) => ({
        ...current,
        shelfId: parsedShelf.shelfId,
        row: parsedShelf.row,
        position: String(parsedShelf.position),
        height: String(parsedShelf.height),
      }));
      if (source === 'manual') {
        setManualScanValue('');
      }
      setStatusMessage(`Shelf ${parsedShelf.shelfId} ready. Scan a barcode, or capture a cover if the book has no ISBN.`);
      return;
    }

    const isbn = normalizeScannedIsbn(scannedValue);
    if (!isbn) {
      if (source === 'manual') {
        setStatusMessage('That value is not a valid ISBN-10 or ISBN-13.');
      }
      return;
    }

    if (source === 'manual') {
      setManualScanValue('');
    }
    await submitIsbn(isbn);
  }

  function handleBarcodeScanned(result: { data: string; type: string }) {
    void handleScannedValue(result.data, 'camera');
  }

  function handleManualScanSubmit() {
    void handleScannedValue(manualScanValue, 'manual');
  }

  function clearShelf() {
    setForm((current) => ({
      ...current,
      shelfId: '',
      row: '',
      position: '1',
      height: '1',
    }));
    setStatusMessage('Shelf cleared. Scan a shelf QR code to begin again.');
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#6d3d14" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.hero}>
          <Text style={styles.kicker}>Shelfscan</Text>
          <Text style={styles.title}>Shelf first, then scan fast</Text>
          <Text style={styles.subtitle}>
            QR shelves and barcodes are auto-detected. Use the cover button when a barcode is missing.
          </Text>
        </View>

        {!token ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Login</Text>
            <Field label="Backend URL" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" />
            <Field label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" />
            <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry />
            <Pressable style={styles.primaryButton} onPress={handleLogin}>
              <Text style={styles.primaryButtonText}>Sign in</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <View style={[styles.cardHeaderRow, isCompactWebLayout && styles.cardHeaderStack]}>
                <View style={styles.cardHeaderContent}>
                  <Text style={styles.cardTitle}>Session active</Text>
                  <Text style={styles.caption}>{baseUrl}</Text>
                </View>
                <Pressable style={[styles.secondaryButton, isCompactWebLayout && styles.secondaryButtonCompact]} onPress={handleLogout}>
                  <Text style={styles.secondaryButtonText}>Logout</Text>
                </Pressable>
              </View>
              <Text style={styles.statusLine}>{statusMessage}</Text>
            </View>

            <View style={styles.card}>
              <View style={[styles.cardHeaderRow, isCompactWebLayout && styles.cardHeaderStack]}>
                <View style={styles.cardHeaderContent}>
                  <Text style={styles.cardTitle}>Camera</Text>
                  <Text style={styles.caption}>{cameraModeLabel}</Text>
                </View>
                {shelfReady ? (
                  <Pressable style={[styles.secondaryButton, isCompactWebLayout && styles.secondaryButtonCompact]} onPress={clearShelf}>
                    <Text style={styles.secondaryButtonText}>Done with shelf</Text>
                  </Pressable>
                ) : null}
              </View>

              {!permission?.granted ? (
                <View style={styles.permissionBox}>
                  <Text style={styles.caption}>Camera permission is required to scan and capture covers.</Text>
                  <Pressable style={styles.primaryButton} onPress={() => requestPermission()}>
                    <Text style={styles.primaryButtonText}>Grant camera access</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.cameraFrame}>
                  <CameraView
                    ref={cameraRef}
                    style={styles.camera}
                    facing="back"
                    mode="picture"
                    barcodeScannerSettings={{ barcodeTypes }}
                    onBarcodeScanned={handleBarcodeScanned}
                  />
                  <View pointerEvents="box-none" style={styles.cameraOverlay}>
                    <View style={styles.cameraBadge}>
                      <Text style={styles.cameraBadgeText}>
                        {scannerMode === 'shelf'
                          ? 'Align shelf QR tag'
                          : isWeb
                            ? 'ISBN optional: enter it manually or capture the cover'
                            : 'Align book barcode'}
                      </Text>
                    </View>
                    <Pressable
                      style={[styles.captureButton, (!shelfReady || submitting) && styles.buttonDisabled]}
                      onPress={handleCaptureCover}
                      disabled={!shelfReady || submitting}
                    >
                      <Text style={styles.captureButtonText}>{submitting ? 'Working...' : 'Capture cover'}</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              {isWeb ? (
                <View style={styles.manualScanBox}>
                  <Text style={styles.manualScanTitle}>
                    {scannerMode === 'shelf' ? 'Manual shelf QR fallback' : 'Manual ISBN fallback'}
                  </Text>
                  <Text style={styles.caption}>
                    {scannerMode === 'shelf'
                      ? 'Browser QR detection can be unreliable. Paste the invscan://shelf/... payload here if the camera misses it.'
                      : 'Expo web barcode support is limited. Paste the ISBN if needed, or skip it and submit only the cover image.'}
                  </Text>
                  <Field
                    label={scannerMode === 'shelf' ? 'Shelf QR payload' : 'ISBN / barcode value'}
                    value={manualScanValue}
                    onChangeText={setManualScanValue}
                    autoCapitalize="none"
                    keyboardType={scannerMode === 'shelf' ? 'default' : 'numbers-and-punctuation'}
                    placeholder={scannerMode === 'shelf' ? 'invscan://shelf/A1?v=1&row=A&position=1&height=3' : '9781234567897'}
                  />
                  <Pressable
                    style={[styles.primaryButton, (!manualScanValue.trim() || submitting) && styles.buttonDisabled]}
                    onPress={handleManualScanSubmit}
                    disabled={!manualScanValue.trim() || submitting}
                  >
                    <Text style={styles.primaryButtonText}>
                      {scannerMode === 'shelf' ? 'Use pasted shelf tag' : 'Use pasted ISBN'}
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Shelf context</Text>
              <Field label="Shelf ID" value={form.shelfId} onChangeText={(value) => updateForm('shelfId', value)} />
              <View style={styles.inlineFields}>
                <View style={styles.inlineField}>
                  <Field label="Row" value={form.row} onChangeText={(value) => updateForm('row', value)} />
                </View>
                <View style={styles.inlineField}>
                  <Field label="Position" value={form.position} onChangeText={(value) => updateForm('position', value)} keyboardType="numeric" />
                </View>
                <View style={styles.inlineField}>
                  <Field label="Height" value={form.height} onChangeText={(value) => updateForm('height', value)} keyboardType="numeric" />
                </View>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Optional enrichment</Text>
              <Field label="Title" value={form.title} onChangeText={(value) => updateForm('title', value)} />
              <Field label="Author" value={form.author} onChangeText={(value) => updateForm('author', value)} />
              <Text style={styles.caption}>
                These values are attached to the next scanned barcode or captured cover, then cleared.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Last response</Text>
              <Text style={styles.responseText}>{lastResponse || 'No submission yet.'}</Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

type FieldProps = {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'numeric' | 'numbers-and-punctuation';
  placeholder?: string;
};

function Field({ label, value, onChangeText, autoCapitalize, secureTextEntry, keyboardType, placeholder }: FieldProps) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType ?? 'default'}
        placeholder={placeholder}
        placeholderTextColor="#8a755d"
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f4efe6',
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f4efe6',
  },
  container: {
    padding: 20,
    gap: 18,
  },
  hero: {
    paddingTop: 12,
    gap: 8,
  },
  kicker: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: '#8b5e34',
  },
  title: {
    fontSize: 32,
    lineHeight: 36,
    fontWeight: '700',
    color: '#2e2418',
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 22,
    color: '#5b4c3b',
    maxWidth: 540,
  },
  card: {
    backgroundColor: '#fffaf2',
    borderRadius: 24,
    padding: 18,
    gap: 14,
    borderWidth: 1,
    borderColor: '#e8dbc6',
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#2e2418',
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  cardHeaderStack: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  cardHeaderContent: {
    flex: 1,
    minWidth: 0,
  },
  caption: {
    color: '#7d684f',
  },
  statusLine: {
    color: '#2e2418',
    fontWeight: '600',
  },
  permissionBox: {
    gap: 12,
  },
  cameraFrame: {
    height: 360,
    overflow: 'hidden',
    borderRadius: 20,
    position: 'relative',
  },
  camera: {
    flex: 1,
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    padding: 16,
    backgroundColor: 'rgba(20, 12, 4, 0.16)',
  },
  cameraBadge: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 250, 242, 0.9)',
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  cameraBadgeText: {
    color: '#2e2418',
    fontWeight: '700',
  },
  captureButton: {
    alignSelf: 'center',
    backgroundColor: '#fffaf2',
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 22,
  },
  captureButtonText: {
    color: '#6d3d14',
    fontWeight: '700',
    fontSize: 16,
  },
  manualScanBox: {
    gap: 12,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#e8dbc6',
  },
  manualScanTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2e2418',
  },
  fieldGroup: {
    gap: 6,
  },
  label: {
    color: '#5b4c3b',
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d9c5aa',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#2e2418',
  },
  inlineFields: {
    flexDirection: 'row',
    gap: 10,
  },
  inlineField: {
    flex: 1,
  },
  primaryButton: {
    backgroundColor: '#8b5e34',
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#fffaf2',
    fontWeight: '700',
    fontSize: 16,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#8b5e34',
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  secondaryButtonText: {
    color: '#8b5e34',
    fontWeight: '700',
  },
  secondaryButtonCompact: {
    alignSelf: 'flex-start',
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  responseText: {
    fontFamily: 'Courier',
    color: '#2e2418',
  },
});