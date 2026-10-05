interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_FLAGS_CLIENT_KEY?: string;
  readonly VITE_FLAGS_RELAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
