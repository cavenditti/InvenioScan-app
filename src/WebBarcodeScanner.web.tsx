import Quagga, { type QuaggaJSConfigObject, type QuaggaJSResultObject } from '@ericblade/quagga2';
import { BrowserMultiFormatReader } from '@zxing/browser';
import {
  BarcodeFormat,
  ChecksumException,
  DecodeHintType,
  FormatException,
  NotFoundException,
} from '@zxing/library';
import 'webrtc-adapter';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type CSSProperties } from 'react';
import { StyleSheet, View } from 'react-native';

import { normalizeScannedIsbn } from './scanner';

export type WebBarcodeScannerMode = 'shelf' | 'book';

export type WebBarcodeScannerCapture = {
  uri: string;
  mimeType: string;
  fileName: string;
  revokeUri?: () => void;
};

export type WebBarcodeScannerHandle = {
  captureImageAsync: () => Promise<WebBarcodeScannerCapture>;
  scanCurrentFrameAsync: () => Promise<string | null>;
};

export type WebBarcodeScannerProps = {
  mode: WebBarcodeScannerMode;
  paused?: boolean;
  onDetected: (value: string) => void;
  onError?: (message: string) => void;
};

const MAX_CAPTURE_WIDTH = 1200;
const MAX_SCAN_FRAME_WIDTH = 1600;
const DUPLICATE_WINDOW_MS = 1400;
const SHELF_SCAN_INTERVAL_MS = 180;
const BOOK_STABLE_DETECTION_REQUIRED = 1;
const BOOK_STABLE_DETECTION_WINDOW_MS = 1600;
const BOOK_FRAME_SCAN_UPSCALE = 1.8;

const BOOK_CONTINUOUS_FORMATS = new Set(['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39']);
const BOOK_STABLE_DETECTION_REQUIRED_BY_FORMAT: Partial<Record<string, number>> = {
  ean_8: 2,
  upc_a: 2,
  upc_e: 2,
  code_128: 2,
  code_39: 3,
};

const BASE_SCAN_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 1280 },
  height: { ideal: 720 },
  aspectRatio: { ideal: 4 / 3 },
};

const SCAN_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: BASE_SCAN_VIDEO_CONSTRAINTS,
};

const SCAN_FORMATS: Record<WebBarcodeScannerMode, BarcodeFormat[]> = {
  shelf: [BarcodeFormat.QR_CODE],
  book: [
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128,
    BarcodeFormat.CODE_39,
  ],
};

const BOOK_QUAGGA_READERS: NonNullable<NonNullable<QuaggaJSConfigObject['decoder']>['readers']> = [
  'ean_reader',
  {
    format: 'ean_reader',
    config: {
      supplements: ['ean_5_reader', 'ean_2_reader'],
    },
  },
  'ean_8_reader',
  'upc_reader',
  'upc_e_reader',
  'code_128_reader',
  'code_39_reader',
];

const BOOK_SCAN_AREA: NonNullable<NonNullable<QuaggaJSConfigObject['inputStream']>['area']> = {
  top: '37%',
  right: '8%',
  bottom: '37%',
  left: '8%',
};

const BOOK_FRAME_SCAN_CROP = {
  top: 0.22,
  right: 0.02,
  bottom: 0.22,
  left: 0.02,
};

const videoStyle: CSSProperties = {
  position: 'absolute',
  inset: '0',
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  objectPosition: 'center center',
  display: 'block',
  backgroundColor: '#1c140d',
};

const quaggaTargetStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  backgroundColor: '#1c140d',
};

function buildHints(mode: WebBarcodeScannerMode) {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, SCAN_FORMATS[mode]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return hints;
}

function isRetryableDecodeError(error: unknown) {
  return error instanceof NotFoundException || error instanceof ChecksumException || error instanceof FormatException;
}

function getScannerErrorMessage(error: unknown) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser cannot access the camera for live scanning. Use manual entry instead.';
  }

  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Camera access was blocked. Grant camera access or use manual entry.';
    }
    if (error.name === 'NotReadableError') {
      return 'The browser could not start the camera. Close other tabs or apps using the camera and retry.';
    }
  }

  return 'The live web barcode scanner could not start. You can still paste the ISBN manually.';
}


function scoreVideoDevice(label: string) {
  const normalizedLabel = label.trim().toLowerCase();
  if (!normalizedLabel) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;

  if (normalizedLabel === 'back camera' || normalizedLabel === 'rear camera') {
    score += 140;
  }
  if (normalizedLabel.includes('back') || normalizedLabel.includes('rear') || normalizedLabel.includes('environment')) {
    score += 100;
  }
  if (normalizedLabel.includes('facetime') || normalizedLabel.includes('front') || normalizedLabel.includes('user')) {
    score -= 120;
  }
  if (normalizedLabel.includes('ultra') || normalizedLabel.includes('0.5') || normalizedLabel.includes('wide')) {
    score -= 75;
  }
  if (normalizedLabel.includes('continuity')) {
    score -= 24;
  }
  if (normalizedLabel.includes('desk view')) {
    score -= 200;
  }

  return score;
}


async function resolvePreferredVideoConstraints() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return BASE_SCAN_VIDEO_CONSTRAINTS;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((device) => device.kind === 'videoinput');
    const preferredDevice = videoInputs
      .map((device) => ({ device, score: scoreVideoDevice(device.label) }))
      .filter((entry) => Number.isFinite(entry.score) && entry.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.device;

    if (!preferredDevice) {
      return BASE_SCAN_VIDEO_CONSTRAINTS;
    }

    return {
      ...BASE_SCAN_VIDEO_CONSTRAINTS,
      deviceId: { exact: preferredDevice.deviceId },
      facingMode: undefined,
    } satisfies MediaTrackConstraints;
  } catch {
    return BASE_SCAN_VIDEO_CONSTRAINTS;
  }
}


async function attachCameraStream(video: HTMLVideoElement, videoConstraints: MediaTrackConstraints) {
  const stream = await navigator.mediaDevices.getUserMedia({
    ...SCAN_CONSTRAINTS,
    video: videoConstraints,
  });
  video.srcObject = stream;

  if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error('Camera preview did not become ready in time.'));
      }, 5000);

      const handleLoadedMetadata = () => {
        cleanup();
        resolve();
      };

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      };

      video.addEventListener('loadedmetadata', handleLoadedMetadata);
    });
  }

  await video.play();
  return stream;
}


function captureVideoFrameCanvas(video: HTMLVideoElement, maxWidth: number) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const scale = sourceWidth > maxWidth ? maxWidth / sourceWidth : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not capture a frame from the camera.');
  }

  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}


function cropCanvas(
  sourceCanvas: HTMLCanvasElement,
  crop: { top: number; right: number; bottom: number; left: number },
  scale = 1
) {
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;
  const cropX = Math.max(0, Math.round(sourceWidth * crop.left));
  const cropY = Math.max(0, Math.round(sourceHeight * crop.top));
  const cropWidth = Math.max(1, Math.round(sourceWidth * (1 - crop.left - crop.right)));
  const cropHeight = Math.max(1, Math.round(sourceHeight * (1 - crop.top - crop.bottom)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cropWidth * scale));
  canvas.height = Math.max(1, Math.round(cropHeight * scale));

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not prepare a cropped frame for barcode scanning.');
  }

  context.drawImage(sourceCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
  return canvas;
}


function rotateCanvas(sourceCanvas: HTMLCanvasElement, degrees: 0 | 180) {
  if (degrees === 0) {
    return sourceCanvas;
  }

  const canvas = document.createElement('canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not prepare a rotated frame for barcode scanning.');
  }

  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((degrees * Math.PI) / 180);
  context.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
  return canvas;
}


function decodeBookCanvas(reader: BrowserMultiFormatReader, canvas: HTMLCanvasElement) {
  try {
    const result = reader.decodeFromCanvas(canvas);
    return normalizeScannedIsbn(result.getText());
  } catch (error) {
    if (isRetryableDecodeError(error)) {
      return null;
    }
    throw error;
  }
}


async function scanBookFrame(video: HTMLVideoElement) {
  const frameCanvas = captureVideoFrameCanvas(video, MAX_SCAN_FRAME_WIDTH);
  const croppedCanvas = cropCanvas(frameCanvas, BOOK_FRAME_SCAN_CROP);
  const upscaledCroppedCanvas = cropCanvas(frameCanvas, BOOK_FRAME_SCAN_CROP, BOOK_FRAME_SCAN_UPSCALE);

  const candidates = [
    upscaledCroppedCanvas,
    croppedCanvas,
    frameCanvas,
    rotateCanvas(upscaledCroppedCanvas, 180),
    rotateCanvas(frameCanvas, 180),
  ];

  for (const candidate of candidates) {
    const reader = new BrowserMultiFormatReader(buildHints('book'));
    const isbn = decodeBookCanvas(reader, candidate);
    if (isbn) {
      return isbn;
    }
  }

  return null;
}


function applyTargetPreviewStyles(target: HTMLDivElement | null) {
  if (!target) {
    return;
  }

  const previewVideo = target.querySelector('video');
  if (previewVideo instanceof HTMLVideoElement) {
    Object.assign(previewVideo.style, videoStyle);
  }

  const canvases = target.querySelectorAll('canvas');
  canvases.forEach((canvas) => {
    canvas.style.display = 'none';
  });
}


const WebBarcodeScanner = forwardRef<WebBarcodeScannerHandle, WebBarcodeScannerProps>(function WebBarcodeScanner(
  { mode, paused = false, onDetected, onError },
  ref
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bookTargetRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef(mode);
  const scanTimerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const bookObserverRef = useRef<MutationObserver | null>(null);
  const bookActiveRef = useRef(false);
  const quaggaDetectedHandlerRef = useRef<((result: QuaggaJSResultObject) => void) | null>(null);
  const onDetectedRef = useRef(onDetected);
  const onErrorRef = useRef(onError);
  const lastDetectionRef = useRef<{ value: string; at: number }>({ value: '', at: 0 });
  const bookCandidateRef = useRef<{ value: string; count: number; at: number }>({ value: '', count: 0, at: 0 });
  const lastErrorRef = useRef('');

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const stopQrScanner = useCallback(() => {
    if (scanTimerRef.current) {
      clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        // Ignore pause failures during teardown.
      }
      video.srcObject = null;
    }
  }, []);

  const stopBookScanner = useCallback(async () => {
    if (bookObserverRef.current) {
      bookObserverRef.current.disconnect();
      bookObserverRef.current = null;
    }

    if (quaggaDetectedHandlerRef.current) {
      Quagga.offDetected(quaggaDetectedHandlerRef.current);
      quaggaDetectedHandlerRef.current = null;
    }

    if (bookActiveRef.current) {
      bookActiveRef.current = false;
      await Quagga.stop().catch(() => undefined);
    }

    if (bookTargetRef.current) {
      bookTargetRef.current.replaceChildren();
    }
  }, []);

  const stopScanner = useCallback(() => {
    stopQrScanner();
    void stopBookScanner();
  }, [stopBookScanner, stopQrScanner]);

  const getActiveVideo = useCallback(() => {
    if (modeRef.current === 'book') {
      const previewVideo = bookTargetRef.current?.querySelector('video');
      return previewVideo instanceof HTMLVideoElement ? previewVideo : null;
    }

    return videoRef.current;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      async captureImageAsync() {
        const video = getActiveVideo();
        if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
          throw new Error('Camera preview is not ready yet.');
        }

        const canvas = captureVideoFrameCanvas(video, MAX_CAPTURE_WIDTH);

        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) => {
            if (value) {
              resolve(value);
              return;
            }

            reject(new Error('Could not encode the captured image.'));
          }, 'image/jpeg', 0.72);
        });

        const uri = URL.createObjectURL(blob);
        return {
          uri,
          mimeType: 'image/jpeg',
          fileName: `cover-${Date.now()}.jpg`,
          revokeUri: () => URL.revokeObjectURL(uri),
        };
      },

      async scanCurrentFrameAsync() {
        const video = getActiveVideo();
        if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
          throw new Error('Camera preview is not ready yet.');
        }

        if (modeRef.current !== 'book') {
          return null;
        }

        return await scanBookFrame(video);
      },
    }),
    [getActiveVideo]
  );

  useEffect(() => {
    if (paused) {
      stopScanner();
      return;
    }

    let active = true;
    lastErrorRef.current = '';
    lastDetectionRef.current = { value: '', at: 0 };
    bookCandidateRef.current = { value: '', count: 0, at: 0 };

    const emitDetection = (detectedValue: string) => {
      const now = Date.now();
      if (
        lastDetectionRef.current.value === detectedValue &&
        now - lastDetectionRef.current.at < DUPLICATE_WINDOW_MS
      ) {
        return;
      }

      lastDetectionRef.current = { value: detectedValue, at: now };
      onDetectedRef.current(detectedValue);
    };

    const emitError = (error: unknown) => {
      const message = getScannerErrorMessage(error);
      if (lastErrorRef.current !== message) {
        lastErrorRef.current = message;
        onErrorRef.current?.(message);
      }
    };

    void (async () => {
      try {
        const videoConstraints = await resolvePreferredVideoConstraints();

        if (mode === 'shelf') {
          await stopBookScanner();
          const video = videoRef.current;
          if (!video) {
            return;
          }

          const stream = await attachCameraStream(video, videoConstraints);
          if (!active) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }

          streamRef.current = stream;
          const qrReader = new BrowserMultiFormatReader(buildHints(mode), {
            delayBetweenScanAttempts: SHELF_SCAN_INTERVAL_MS,
            delayBetweenScanSuccess: 900,
            tryPlayVideoTimeout: 5000,
          });

          const scanShelfFrame = () => {
            if (!active) {
              return;
            }

            try {
              const result = qrReader.decode(video);
              emitDetection(result.getText());
            } catch (error) {
              if (!isRetryableDecodeError(error)) {
                emitError(error);
              }
            } finally {
              if (active) {
                scanTimerRef.current = window.setTimeout(scanShelfFrame, SHELF_SCAN_INTERVAL_MS);
              }
            }
          };

          scanShelfFrame();
          return;
        }

        stopQrScanner();
        await stopBookScanner();

        const target = bookTargetRef.current;
        if (!target) {
          return;
        }

        const observer = new MutationObserver(() => {
          applyTargetPreviewStyles(target);
        });
        observer.observe(target, { childList: true, subtree: true });
        bookObserverRef.current = observer;

        const detectedHandler = (result: QuaggaJSResultObject) => {
          const detectedValue = result.codeResult?.code?.trim();
          const detectedFormat = result.codeResult?.format;

          if (!detectedValue || !detectedFormat || !BOOK_CONTINUOUS_FORMATS.has(detectedFormat)) {
            bookCandidateRef.current = { value: '', count: 0, at: 0 };
            return;
          }

          const normalizedIsbn = normalizeScannedIsbn(detectedValue);
          const candidateValue = normalizedIsbn ?? detectedValue;
          const now = Date.now();
          const candidate = bookCandidateRef.current;
          const requiredDetections =
            BOOK_STABLE_DETECTION_REQUIRED_BY_FORMAT[detectedFormat] ?? BOOK_STABLE_DETECTION_REQUIRED;
          if (candidate.value === candidateValue && now - candidate.at < BOOK_STABLE_DETECTION_WINDOW_MS) {
            candidate.count += 1;
            candidate.at = now;
          } else {
            bookCandidateRef.current = { value: candidateValue, count: 1, at: now };
            return;
          }

          if (candidate.count >= requiredDetections) {
            bookCandidateRef.current = { value: '', count: 0, at: 0 };
            emitDetection(detectedValue);
          }
        };

        quaggaDetectedHandlerRef.current = detectedHandler;
        Quagga.onDetected(detectedHandler);

        const config: QuaggaJSConfigObject = {
          inputStream: {
            type: 'LiveStream',
            target,
            constraints: videoConstraints,
            area: BOOK_SCAN_AREA,
            willReadFrequently: true,
          },
          locate: false,
          numOfWorkers: 0,
          frequency: 10,
          canvas: {
            createOverlay: false,
          },
          locator: {
            halfSample: true,
            patchSize: 'medium',
          },
          decoder: {
            readers: BOOK_QUAGGA_READERS,
            multiple: false,
          },
        };

        bookActiveRef.current = true;
        await Quagga.start(config);
        if (!active) {
          await stopBookScanner();
          return;
        }

        applyTargetPreviewStyles(target);
      } catch (error) {
        bookActiveRef.current = false;
        if (active) {
          emitError(error);
        }
      }
    })();

    return () => {
      active = false;
      stopScanner();
    };
  }, [mode, paused, stopScanner]);

  return (
    <View style={styles.container}>
      {mode === 'book' ? (
        <div ref={bookTargetRef} style={quaggaTargetStyle} />
      ) : (
        <video autoPlay muted playsInline ref={videoRef} style={videoStyle} />
      )}
    </View>
  );
});

export default WebBarcodeScanner;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1c140d',
  },
});