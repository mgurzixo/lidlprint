import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.gurzixo.lidlprint',
  appName: 'LidlPrint',
  webDir: 'dist/spa',
  // single android tree — the one quasar dev -m capacitor uses and AS opens
  android: {
    path: 'src-capacitor/android'
  }
};

export default config;
