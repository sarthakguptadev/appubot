/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_APPUBOT_MOCK?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
