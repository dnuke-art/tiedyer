import type { CapacitorConfig } from '@capacitor/cli';

// The iOS app is the same Vite build as the website (`npm run build:ios`), served
// from the bundle by a WKWebView. Nothing is loaded from the network.
const config: CapacitorConfig = {
  appId: 'com.dnuke.tiedyer',
  appName: 'tiedyer',
  webDir: 'dist',
  backgroundColor: '#1b1b1f',
  ios: {
    contentInset: 'never',
    scrollEnabled: false,
    preferredContentMode: 'mobile',
  },
};

export default config;
