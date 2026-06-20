/**
 * Platform context. The same screens run in two homes:
 *   - 'local'  — the single-file / desktop edition (in-browser or Electron DB)
 *   - 'server' — the hosted multi-user edition (logs in, picks an organisation)
 *
 * The top bar reads this to show either the local books/profile switchers or
 * the server's organisation switcher + signed-in user menu. Everything below
 * the top bar is identical, because every screen calls the same api().
 */
import React from 'react';

export type Tenant = { id: number; name: string; role?: string; is_owner?: number };
export type PlatformUser = { id: number; email?: string; full_name?: string };

export type Platform = {
  mode: 'local' | 'server';
  user?: PlatformUser | null;
  tenants?: Tenant[];
  activeTenant?: Tenant | null;
  switchTenant?: (id: number) => void;
  logout?: () => void;
};

export const PlatformContext = React.createContext<Platform>({ mode: 'local' });
export const usePlatform = () => React.useContext(PlatformContext);
