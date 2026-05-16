import { SidelightApi } from '../shared/domain';

declare module '*?url' {
  const url: string;
  export default url;
}

declare global {
  interface Window {
    sidelight: SidelightApi;
  }
}

export {};
