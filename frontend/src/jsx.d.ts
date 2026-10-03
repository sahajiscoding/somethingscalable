/* Vendored React Bits components ship as untyped .jsx (props by design).
   Vite bundles them; TypeScript treats them as prop-flexible components. */
declare module '*.jsx' {
  import type { ComponentType } from 'react';
  const Component: ComponentType<Record<string, unknown>>;
  export default Component;
}
