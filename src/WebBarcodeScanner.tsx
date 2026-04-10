import { forwardRef } from 'react';
import { View } from 'react-native';

export type WebBarcodeScannerMode = 'shelf' | 'book';

export type WebBarcodeScannerCapture = {
  uri: string;
  mimeType: string;
  fileName: string;
  revokeUri?: () => void;
};

export type WebBarcodeScannerHandle = {
  captureImageAsync: () => Promise<WebBarcodeScannerCapture>;
};

export type WebBarcodeScannerProps = {
  mode: WebBarcodeScannerMode;
  paused?: boolean;
  onDetected: (value: string) => void;
  onError?: (message: string) => void;
};

const WebBarcodeScanner = forwardRef<WebBarcodeScannerHandle, WebBarcodeScannerProps>(
  function WebBarcodeScanner() {
    return <View />;
  }
);

export default WebBarcodeScanner;