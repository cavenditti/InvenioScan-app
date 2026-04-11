import { StatusBar } from 'expo-status-bar';
import * as ImageManipulator from 'expo-image-manipulator';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeType } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
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

import { login, submitImageIngest, submitIsbnIngest, type IngestResponse } from './src/api';
import { normalizeScannedIsbn, parseShelfPayload } from './src/scanner';
import { clearSession, loadSession, saveSession } from './src/storage';
import WebBarcodeScanner, { type WebBarcodeScannerCapture, type WebBarcodeScannerHandle } from './src/WebBarcodeScanner';

type FormState = {
  shelfId: string;
  row: string;
  position: string;
  height: string;
  title: string;
  author: string;
  publicationYear: string;
  documentType: string;
  language: string;
  notes: string;
};

type ScanSource = 'camera' | 'manual';
type CameraOverlayMode = 'scan' | 'cover';

type SuccessDialogState = {
  title: string;
  message: string;
  response: IngestResponse;
};

const initialFormState: FormState = {
  shelfId: '',
  row: '',
  position: '1',
  height: '1',
  title: '',
  author: '',
  publicationYear: '',
  documentType: '',
  language: '',
  notes: '',
};

export default function App() {
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8000');
  const [username, setUsername] = useState('operator');
  const [password, setPassword] = useState('operator');
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [frameScanning, setFrameScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Scan a shelf tag to lock in the location.');
  const [manualShelfValue, setManualShelfValue] = useState('');
  const [manualIsbnValue, setManualIsbnValue] = useState('');
  const [isShelfEditorOpen, setIsShelfEditorOpen] = useState(false);
  const [isEnrichmentOpen, setIsEnrichmentOpen] = useState(false);
  const [cameraOverlayMode, setCameraOverlayMode] = useState<CameraOverlayMode>('scan');
  const [successDialog, setSuccessDialog] = useState<SuccessDialogState | null>(null);
  const [form, setForm] = useState<FormState>(initialFormState);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const webScannerRef = useRef<WebBarcodeScannerHandle | null>(null);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width } = useWindowDimensions();
  const isWeb = Platform.OS === 'web';
  const isCompactWebLayout = isWeb && width < 520;

  const shelfReady = Boolean(
    form.shelfId.trim() && form.row.trim() && form.position.trim() && form.height.trim()
  );
  const scannerMode = shelfReady ? 'book' : 'shelf';
  const isCoverCaptureMode = cameraOverlayMode === 'cover';
  const scannerPaused = submitting || scanLocked || isCoverCaptureMode || Boolean(successDialog);
  const operatorName = username.trim() || 'Operator';
  const barcodeTypes: BarcodeType[] = scannerMode === 'shelf'
    ? ['qr']
    : ['ean13'];
  const cameraModeLabel = scannerMode === 'shelf'
    ? 'Scan the shelf tag once to lock the location.'
    : isCoverCaptureMode
      ? 'Cover mode is active. Frame the full cover before saving.'
      : 'Scan ISBNs quickly, or switch to cover mode for books without a readable barcode.';

  useEffect(() => {
    async function restoreSession() {
      const session = await loadSession();
      if (session) {
        setToken(session.token);
        setBaseUrl(session.baseUrl);
        if (session.username) {
          setUsername(session.username);
        }
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

  useEffect(() => {
    if (!shelfReady && cameraOverlayMode !== 'scan') {
      setCameraOverlayMode('scan');
    }
  }, [cameraOverlayMode, shelfReady]);

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
      publicationYear: '',
      documentType: '',
      language: '',
      notes: '',
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
      setUsername(normalizedUsername);
      setStatusMessage('Scan a shelf tag to lock in the location.');

      saveSession(session.access_token, normalizedBaseUrl, normalizedUsername).catch(() => undefined);
    } catch (error) {
      Alert.alert('Login failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await clearSession();
    setToken(null);
    setManualShelfValue('');
    setManualIsbnValue('');
    setIsShelfEditorOpen(false);
    setIsEnrichmentOpen(false);
    setCameraOverlayMode('scan');
    setSuccessDialog(null);
    setForm(initialFormState);
    setStatusMessage('Scan a shelf tag to lock in the location.');
  }

  function buildBookMetadata() {
    const publicationYearValue = form.publicationYear.trim();
    let publicationYear: number | undefined;

    if (publicationYearValue) {
      const parsedPublicationYear = Number.parseInt(publicationYearValue, 10);
      if (Number.isNaN(parsedPublicationYear)) {
        return {
          error: 'Publication year must be a whole number.',
        };
      }
      publicationYear = parsedPublicationYear;
    }

    return {
      metadata: {
        title: form.title.trim() || undefined,
        author: form.author.trim() || undefined,
        publicationYear,
        documentType: form.documentType.trim() || undefined,
        language: form.language.trim() || undefined,
        notes: form.notes.trim() || undefined,
      },
    };
  }

  function openSuccessDialog(title: string, message: string, response: IngestResponse) {
    setSuccessDialog({ title, message, response });
  }

  function beginCoverCapture() {
    if (!shelfReady) {
      Alert.alert('Missing shelf', 'Scan or enter the shelf details first.');
      return;
    }

    setCameraOverlayMode('cover');
    setStatusMessage('Cover mode is active. Frame the full front cover, then tap Save cover.');
  }

  function cancelCoverCapture() {
    setCameraOverlayMode('scan');
    setStatusMessage('Back in barcode mode. Scan the next ISBN or switch back to cover mode.');
  }

  async function handleFrameScan() {
    if (!isWeb || !webScannerRef.current) {
      return;
    }

    try {
      setFrameScanning(true);
      setStatusMessage('Analyzing the current frame for an ISBN...');
      const scannedIsbn = await webScannerRef.current.scanCurrentFrameAsync();

      if (!scannedIsbn) {
        setStatusMessage('Could not read a valid ISBN from the current frame. Move closer, center the barcode, and try again.');
        return;
      }

      await submitIsbn(scannedIsbn);
    } catch (error) {
      Alert.alert('Frame scan failed', error instanceof Error ? error.message : 'Unknown error');
      setStatusMessage('Frame scan failed.');
    } finally {
      setFrameScanning(false);
    }
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

    const metadataResult = buildBookMetadata();
    if ('error' in metadataResult) {
      const errorMessage = metadataResult.error ?? 'Invalid book details.';
      Alert.alert('Invalid book details', errorMessage);
      setStatusMessage(errorMessage);
      return;
    }

    let didSucceed = false;

    try {
      setSubmitting(true);
      const response = await submitIsbnIngest(baseUrl.trim(), token, {
        shelf,
        isbn,
        ...metadataResult.metadata,
      });
      didSucceed = true;
      setStatusMessage('Scan saved. Keep going on this shelf.');
      openSuccessDialog('Scan saved', 'The server created a copy for this shelf position.', response);
      resetBookMetadata();
      setIsEnrichmentOpen(false);
    } catch (error) {
      Alert.alert('ISBN ingest failed', error instanceof Error ? error.message : 'Unknown error');
      setStatusMessage('ISBN ingest failed.');
    } finally {
      setSubmitting(false);
      if (didSucceed) {
        lockScanner();
      }
    }
  }

  async function handleCaptureCover() {
    if (!token) {
      return;
    }

    const shelf = buildShelfPayload();
    if (!shelf) {
      Alert.alert('Missing shelf', 'Scan or fill in the shelf details first.');
      return;
    }

    const metadataResult = buildBookMetadata();
    if ('error' in metadataResult) {
      const errorMessage = metadataResult.error ?? 'Invalid book details.';
      Alert.alert('Invalid book details', errorMessage);
      setStatusMessage(errorMessage);
      return;
    }

    let webCapture: WebBarcodeScannerCapture | null = null;
    let didSucceed = false;

    try {
      setSubmitting(true);
      let imageUri = '';
      let mimeType = 'image/jpeg';
      let fileName = `cover-${Date.now()}.jpg`;

      if (isWeb) {
        if (!webScannerRef.current) {
          throw new Error('Web camera preview is not ready yet.');
        }

        webCapture = await webScannerRef.current.captureImageAsync();
        imageUri = webCapture.uri;
        mimeType = webCapture.mimeType;
        fileName = webCapture.fileName;
      } else {
        if (!cameraRef.current) {
          throw new Error('Camera preview is not ready yet.');
        }

        const photo = await cameraRef.current.takePictureAsync({ quality: 0.8, skipProcessing: false });
        if (!photo?.uri) {
          throw new Error('Camera did not return an image.');
        }

        const manipulated = await ImageManipulator.manipulateAsync(
          photo.uri,
          [{ resize: { width: 1200 } }],
          { compress: 0.72, format: ImageManipulator.SaveFormat.JPEG }
        );

        imageUri = manipulated.uri;
      }

      const response = await submitImageIngest(baseUrl.trim(), token, {
        shelf,
        imageUri,
        ...metadataResult.metadata,
        mimeType,
        fileName,
      });

      didSucceed = true;
      setCameraOverlayMode('scan');
      setStatusMessage('Cover saved. Continue with the next book on this shelf.');
      openSuccessDialog('Cover saved', 'The cover image was uploaded and a copy was created.', response);
      resetBookMetadata();
      setIsEnrichmentOpen(false);
    } catch (error) {
      Alert.alert('Image ingest failed', error instanceof Error ? error.message : 'Unknown error');
      setStatusMessage('Image ingest failed.');
    } finally {
      webCapture?.revokeUri?.();
      setSubmitting(false);
      if (didSucceed) {
        lockScanner(1500);
      }
    }
  }

  async function handleScannedValue(value: string, source: ScanSource) {
    if (!token || submitting || (source === 'camera' && (scanLocked || frameScanning))) {
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
        console.info('[Shelfscan] Ignored shelf candidate', { source, scannedValue });
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
      setIsShelfEditorOpen(false);
      setCameraOverlayMode('scan');
      if (source === 'manual') {
        setManualShelfValue('');
      }
      setStatusMessage(`Shelf ${parsedShelf.shelfId} locked in. Scan ISBNs, or switch to cover mode for books without barcodes.`);
      return;
    }

    const isbn = normalizeScannedIsbn(scannedValue);
    if (!isbn) {
      console.info('[Shelfscan] Rejected non-ISBN barcode', { source, scannedValue });
      setStatusMessage(
        source === 'manual'
          ? 'That value is not a valid ISBN-10 or ISBN-13.'
          : 'Detected a barcode, but it did not match a usable ISBN. Try again or paste it manually.'
      );
      return;
    }

    if (source === 'manual') {
      setManualIsbnValue('');
    }
    await submitIsbn(isbn);
  }

  function handleBarcodeScanned(result: { data: string; type: string }) {
    void handleScannedValue(result.data, 'camera');
  }

  function handleManualShelfSubmit() {
    void handleScannedValue(manualShelfValue, 'manual');
  }

  function handleManualIsbnSubmit() {
    void handleScannedValue(manualIsbnValue, 'manual');
  }

  function clearShelf() {
    setForm((current) => ({
      ...current,
      shelfId: '',
      row: '',
      position: '1',
      height: '1',
    }));
    setManualShelfValue('');
    setCameraOverlayMode('scan');
    setIsShelfEditorOpen(false);
    setStatusMessage('Shelf cleared. Scan the next shelf tag to begin again.');
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
        {token ? (
          <View style={styles.operatorBar}>
            <View style={styles.operatorAvatar}>
              <Text style={styles.operatorAvatarText}>{operatorName.charAt(0).toUpperCase()}</Text>
            </View>
            <View style={styles.operatorMeta}>
              <Text style={styles.operatorLabel}>Signed in as</Text>
              <Text style={styles.operatorName}>{operatorName}</Text>
              <Text style={styles.operatorHost}>{baseUrl}</Text>
            </View>
            <Pressable style={[styles.secondaryButton, isCompactWebLayout && styles.secondaryButtonCompact]} onPress={handleLogout}>
              <Text style={styles.secondaryButtonText}>Logout</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.hero}>
          <Text style={styles.kicker}>{token ? 'Scanning run' : 'Shelfscan'}</Text>
          <Text style={styles.title}>{token ? 'One shelf, then move book by book' : 'Shelf-first intake'}</Text>
          <Text style={styles.subtitle}>
            {token
              ? 'Lock the shelf once. Scan ISBNs quickly, or switch to cover mode for books without a readable barcode.'
              : 'Sign in to start a compact shelf-based scanning run.'}
          </Text>
        </View>

        {!token ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Session setup</Text>
            <Text style={styles.caption}>Connect to the backend and open a new scanning run.</Text>
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
                  <Text style={styles.cardTitle}>Shelf</Text>
                  <Text style={styles.caption}>
                    {shelfReady
                      ? 'This shelf stays active until you clear it.'
                      : 'Scan a shelf tag or open the editor to enter the location manually.'}
                  </Text>
                </View>
                <View style={[styles.inlineActionGroup, isCompactWebLayout && styles.inlineActionGroupStack]}>
                  <Pressable
                    style={[styles.secondaryButton, isCompactWebLayout && styles.secondaryButtonCompact]}
                    onPress={() => setIsShelfEditorOpen((current) => !current)}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {isShelfEditorOpen ? 'Hide editor' : shelfReady ? 'Edit shelf' : 'Enter manually'}
                    </Text>
                  </Pressable>
                  {shelfReady ? (
                    <Pressable style={[styles.secondaryButton, isCompactWebLayout && styles.secondaryButtonCompact]} onPress={clearShelf}>
                      <Text style={styles.secondaryButtonText}>Done with shelf</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>

              {shelfReady ? (
                <View style={styles.shelfSummaryRow}>
                  <View style={styles.shelfSummaryChip}>
                    <Text style={styles.shelfSummaryLabel}>Shelf</Text>
                    <Text style={styles.shelfSummaryValue}>{form.shelfId}</Text>
                  </View>
                  <View style={styles.shelfSummaryChip}>
                    <Text style={styles.shelfSummaryLabel}>Row</Text>
                    <Text style={styles.shelfSummaryValue}>{form.row}</Text>
                  </View>
                  <View style={styles.shelfSummaryChip}>
                    <Text style={styles.shelfSummaryLabel}>Position</Text>
                    <Text style={styles.shelfSummaryValue}>{form.position}</Text>
                  </View>
                  <View style={styles.shelfSummaryChip}>
                    <Text style={styles.shelfSummaryLabel}>Height</Text>
                    <Text style={styles.shelfSummaryValue}>{form.height}</Text>
                  </View>
                </View>
              ) : (
                <View style={styles.emptyShelfNotice}>
                  <Text style={styles.statusLine}>No shelf locked in yet.</Text>
                  <Text style={styles.caption}>Use the live scanner, or open the manual editor below.</Text>
                </View>
              )}

              {isShelfEditorOpen ? (
                <>
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

                  {isWeb ? (
                    <View style={styles.manualScanBox}>
                      <Text style={styles.manualScanTitle}>Paste a shelf tag</Text>
                      <Text style={styles.caption}>
                        If browser QR detection misses the tag, paste the full invscan://shelf/... payload here.
                      </Text>
                      <Field
                        label="Shelf QR payload"
                        value={manualShelfValue}
                        onChangeText={setManualShelfValue}
                        autoCapitalize="none"
                        placeholder="invscan://shelf/A1?v=1&row=A&position=1&height=3"
                      />
                      <Pressable
                        style={[styles.primaryButton, (!manualShelfValue.trim() || submitting) && styles.buttonDisabled]}
                        onPress={handleManualShelfSubmit}
                        disabled={!manualShelfValue.trim() || submitting}
                      >
                        <Text style={styles.primaryButtonText}>Use pasted shelf tag</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </>
              ) : null}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Camera</Text>
              <Text style={styles.caption}>{cameraModeLabel}</Text>

              {!permission?.granted ? (
                <View style={styles.permissionBox}>
                  <Text style={styles.caption}>Camera permission is required to scan and capture covers.</Text>
                  <Pressable style={styles.primaryButton} onPress={() => requestPermission()}>
                    <Text style={styles.primaryButtonText}>Grant camera access</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.cameraFrame}>
                  {isWeb ? (
                    <WebBarcodeScanner
                      ref={webScannerRef}
                      mode={scannerMode}
                      paused={scannerPaused}
                      onDetected={(value) => {
                        void handleScannedValue(value, 'camera');
                      }}
                      onError={(message) => {
                        setStatusMessage(message);
                      }}
                    />
                  ) : (
                    <CameraView
                      ref={cameraRef}
                      style={styles.camera}
                      facing="back"
                      mode="picture"
                      barcodeScannerSettings={{ barcodeTypes }}
                      onBarcodeScanned={scannerPaused ? undefined : handleBarcodeScanned}
                    />
                  )}
                  <View pointerEvents="box-none" style={styles.cameraOverlay}>
                    <View style={styles.cameraBadge}>
                      <Text style={styles.cameraBadgeText}>
                        {scannerMode === 'shelf'
                          ? 'Shelf tag mode'
                          : isCoverCaptureMode
                            ? 'Cover framing mode'
                            : 'ISBN scanning mode'}
                      </Text>
                    </View>
                    <View style={styles.scanGuideWrap}>
                      <View
                        style={[
                          styles.scanGuideFrame,
                          scannerMode === 'shelf'
                            ? styles.scanGuideSquare
                            : isCoverCaptureMode
                              ? styles.scanGuideTall
                              : styles.scanGuideWide,
                        ]}
                      >
                        {scannerMode === 'book' && !isCoverCaptureMode ? <View style={styles.scanGuideLine} /> : null}
                      </View>
                      <Text style={styles.scanGuideText}>
                        {scannerMode === 'shelf'
                          ? 'Keep the full shelf tag inside the frame'
                          : isCoverCaptureMode
                            ? 'Fit the full front cover inside the border, then save it'
                            : 'Center the ISBN barcode inside the band'}
                      </Text>
                    </View>

                    {shelfReady ? (
                      <View style={styles.cameraActionGroup}>
                        {isCoverCaptureMode ? (
                          <>
                            <Pressable
                              style={[styles.captureButton, (submitting || frameScanning) && styles.buttonDisabled]}
                              onPress={handleCaptureCover}
                              disabled={submitting || frameScanning}
                            >
                              <Text style={styles.captureButtonText}>{submitting ? 'Saving...' : 'Save cover'}</Text>
                            </Pressable>
                            <Pressable
                              style={[styles.captureSecondaryButton, (submitting || frameScanning) && styles.buttonDisabled]}
                              onPress={cancelCoverCapture}
                              disabled={submitting || frameScanning}
                            >
                              <Text style={styles.captureSecondaryButtonText}>Back to barcode mode</Text>
                            </Pressable>
                          </>
                        ) : scannerMode === 'book' ? (
                          <>
                            {isWeb ? (
                              <Pressable
                                style={[styles.captureButton, (submitting || frameScanning) && styles.buttonDisabled]}
                                onPress={handleFrameScan}
                                disabled={submitting || frameScanning}
                              >
                                <Text style={styles.captureButtonText}>{frameScanning ? 'Reading frame...' : 'Read visible barcode'}</Text>
                              </Pressable>
                            ) : null}
                            <Pressable
                              style={[
                                isWeb ? styles.captureSecondaryButton : styles.captureButton,
                                (submitting || frameScanning) && styles.buttonDisabled,
                              ]}
                              onPress={beginCoverCapture}
                              disabled={submitting || frameScanning}
                            >
                              <Text style={isWeb ? styles.captureSecondaryButtonText : styles.captureButtonText}>Switch to cover mode</Text>
                            </Pressable>
                          </>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                </View>
              )}

              <View style={styles.cameraStatusBox}>
                <Text style={styles.statusLine}>{statusMessage}</Text>
              </View>

              {isWeb && scannerMode === 'book' ? (
                <View style={styles.manualScanBox}>
                  <Text style={styles.manualScanTitle}>Manual ISBN fallback</Text>
                  <Text style={styles.caption}>
                    If the live scanner misses a damaged or faint barcode, paste the ISBN here or switch to cover mode and save the book cover instead.
                  </Text>
                  <Field
                    label="ISBN / barcode value"
                    value={manualIsbnValue}
                    onChangeText={setManualIsbnValue}
                    autoCapitalize="none"
                    keyboardType="numbers-and-punctuation"
                    placeholder="9781234567897"
                  />
                  <Pressable
                    style={[styles.primaryButton, (!manualIsbnValue.trim() || submitting || frameScanning) && styles.buttonDisabled]}
                    onPress={handleManualIsbnSubmit}
                    disabled={!manualIsbnValue.trim() || submitting || frameScanning}
                  >
                    <Text style={styles.primaryButtonText}>Use pasted ISBN</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>

            <View style={styles.card}>
              <Pressable style={styles.sectionToggle} onPress={() => setIsEnrichmentOpen((current) => !current)}>
                <View style={styles.cardHeaderContent}>
                  <Text style={styles.cardTitle}>Optional book details</Text>
                  <Text style={styles.caption}>
                    Title, author, publication year, document type, language, and notes. These apply only to the next successful scan or cover save.
                  </Text>
                </View>
                <Text style={styles.sectionToggleText}>{isEnrichmentOpen ? 'Hide' : 'Expand'}</Text>
              </Pressable>

              {isEnrichmentOpen ? (
                <>
                  <Field label="Title" value={form.title} onChangeText={(value) => updateForm('title', value)} />
                  <Field label="Author" value={form.author} onChangeText={(value) => updateForm('author', value)} />
                  <View style={styles.inlineFields}>
                    <View style={styles.inlineField}>
                      <Field
                        label="Publication year"
                        value={form.publicationYear}
                        onChangeText={(value) => updateForm('publicationYear', value)}
                        keyboardType="numeric"
                        placeholder="1954"
                      />
                    </View>
                    <View style={styles.inlineField}>
                      <Field
                        label="Document type"
                        value={form.documentType}
                        onChangeText={(value) => updateForm('documentType', value)}
                        autoCapitalize="characters"
                        placeholder="BOOK"
                      />
                    </View>
                  </View>
                  <Field
                    label="Language"
                    value={form.language}
                    onChangeText={(value) => updateForm('language', value)}
                    autoCapitalize="none"
                    placeholder="en"
                  />
                  <Field
                    label="Notes"
                    value={form.notes}
                    onChangeText={(value) => updateForm('notes', value)}
                    multiline
                    numberOfLines={4}
                    placeholder="Anything the next ingest should retain about this book."
                  />
                </>
              ) : (
                <Text style={styles.caption}>Collapsed until you need to add manual book details.</Text>
              )}
            </View>
          </>
        )}
      </ScrollView>

      <Modal visible={Boolean(successDialog)} transparent animationType="fade" onRequestClose={() => setSuccessDialog(null)}>
        <View style={styles.modalScrim}>
          <View style={styles.modalCard}>
            <Text style={styles.modalKicker}>Saved</Text>
            <Text style={styles.modalTitle}>{successDialog?.title}</Text>
            <Text style={styles.caption}>{successDialog?.message}</Text>

            {successDialog ? (
              <View style={styles.modalDetails}>
                <View style={styles.modalDetailRow}>
                  <Text style={styles.modalDetailLabel}>Status</Text>
                  <Text style={styles.modalDetailValue}>{successDialog.response.status}</Text>
                </View>
                <View style={styles.modalDetailRow}>
                  <Text style={styles.modalDetailLabel}>Book ID</Text>
                  <Text style={styles.modalDetailValue}>{String(successDialog.response.book_id)}</Text>
                </View>
                <View style={styles.modalDetailRow}>
                  <Text style={styles.modalDetailLabel}>Copy ID</Text>
                  <Text style={styles.modalDetailValue}>{String(successDialog.response.copy_id)}</Text>
                </View>
                <View style={styles.modalDetailRowLast}>
                  <Text style={styles.modalDetailLabel}>Scan ID</Text>
                  <Text style={styles.modalDetailValueMono}>{successDialog.response.scan_id}</Text>
                </View>
              </View>
            ) : null}

            <Pressable style={styles.primaryButton} onPress={() => setSuccessDialog(null)}>
              <Text style={styles.primaryButtonText}>Continue scanning</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
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
  multiline?: boolean;
  numberOfLines?: number;
};

function Field({ label, value, onChangeText, autoCapitalize, secureTextEntry, keyboardType, placeholder, multiline, numberOfLines }: FieldProps) {
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
        multiline={multiline}
        numberOfLines={numberOfLines}
        textAlignVertical={multiline ? 'top' : 'center'}
        style={[styles.input, multiline && styles.inputMultiline]}
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
  operatorBar: {
    backgroundColor: '#fffaf2',
    borderRadius: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e8dbc6',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  operatorAvatar: {
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#8b5e34',
  },
  operatorAvatarText: {
    color: '#fffaf2',
    fontSize: 18,
    fontWeight: '700',
  },
  operatorMeta: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  operatorLabel: {
    color: '#8b5e34',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  operatorName: {
    color: '#2e2418',
    fontSize: 20,
    fontWeight: '700',
  },
  operatorHost: {
    color: '#7d684f',
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
  inlineActionGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'flex-end',
  },
  inlineActionGroupStack: {
    justifyContent: 'flex-start',
  },
  caption: {
    color: '#7d684f',
  },
  statusLine: {
    color: '#2e2418',
    fontWeight: '600',
  },
  emptyShelfNotice: {
    gap: 4,
  },
  shelfSummaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  shelfSummaryChip: {
    minWidth: 88,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 18,
    backgroundColor: '#f1e2cf',
    borderWidth: 1,
    borderColor: '#e3d0b7',
    gap: 2,
  },
  shelfSummaryLabel: {
    color: '#8b5e34',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  shelfSummaryValue: {
    color: '#2e2418',
    fontSize: 16,
    fontWeight: '700',
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
  scanGuideWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  scanGuideFrame: {
    borderWidth: 2,
    borderColor: 'rgba(255, 250, 242, 0.92)',
    backgroundColor: 'rgba(255, 250, 242, 0.06)',
    overflow: 'hidden',
  },
  scanGuideSquare: {
    width: 190,
    height: 190,
    borderRadius: 24,
  },
  scanGuideWide: {
    width: '82%',
    maxWidth: 320,
    height: 124,
    borderRadius: 20,
    justifyContent: 'center',
  },
  scanGuideTall: {
    width: '68%',
    maxWidth: 260,
    aspectRatio: 0.7,
    borderRadius: 24,
  },
  scanGuideLine: {
    height: 3,
    marginHorizontal: 16,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 250, 242, 0.92)',
  },
  scanGuideText: {
    color: '#fffaf2',
    fontWeight: '700',
    textAlign: 'center',
    textShadowColor: 'rgba(20, 12, 4, 0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  cameraActionGroup: {
    alignItems: 'center',
    gap: 10,
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
  captureSecondaryButton: {
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 250, 242, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255, 250, 242, 0.4)',
  },
  captureSecondaryButtonText: {
    color: '#fffaf2',
    fontWeight: '700',
  },
  manualScanBox: {
    gap: 12,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#e8dbc6',
  },
  cameraStatusBox: {
    gap: 4,
    paddingTop: 2,
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
  inputMultiline: {
    minHeight: 116,
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
  sectionToggle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  sectionToggleText: {
    color: '#8b5e34',
    fontWeight: '700',
    paddingTop: 4,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  modalScrim: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20, 12, 4, 0.45)',
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#fffaf2',
    borderRadius: 28,
    padding: 22,
    gap: 14,
    borderWidth: 1,
    borderColor: '#e8dbc6',
  },
  modalKicker: {
    color: '#8b5e34',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  modalTitle: {
    color: '#2e2418',
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '700',
  },
  modalDetails: {
    borderWidth: 1,
    borderColor: '#eadbc8',
    borderRadius: 20,
    overflow: 'hidden',
  },
  modalDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1e6d8',
  },
  modalDetailRowLast: {
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  modalDetailLabel: {
    color: '#7d684f',
    fontWeight: '600',
  },
  modalDetailValue: {
    color: '#2e2418',
    fontWeight: '700',
  },
  modalDetailValueMono: {
    color: '#2e2418',
    fontFamily: 'Courier',
  },
});