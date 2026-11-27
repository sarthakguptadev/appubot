import { createIcon, type IconComponent } from '../../components/ui/icons';
import type { IconSvgElement } from '@hugeicons/react';

/*
 * Settings' own icons: Lucide's line icons (ISC licence), the set the reference's Settings draws with, so its nav and
 * controls read the same (the owner's call 2026-11-27, Settings only). Drawn through the app's `createIcon`, so the
 * line weight matches every other icon. `createIcon` joins an icon's paths into one, so every path here opens with an
 * absolute move and names its line commands (Lucide's relative openings would start from the last path's end).
 */
const ROUND = { strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const lucide = (name: string, ...d: string[]): IconComponent =>
  createIcon(d.map((p) => ['path', { d: p, ...ROUND }]) as unknown as IconSvgElement, name);
const circle = (cx: number, cy: number, r: number): string => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

export const SettingsGear = lucide('SettingsGear',
  'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
  circle(12, 12, 3));
export const SettingsMonitor = lucide('SettingsMonitor', 'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M8 21h8', 'M12 17v4');
export const SettingsShield = lucide('SettingsShield', 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z');
/** a strongbox: a square with a lock's star in it (no open set has the reference's vault glyph; drawn to match it) */
export const SettingsVault = lucide('SettingsVault',
  'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  'M9 9q3 1.6 6 0q-1.6 3 0 6q-3-1.6-6 0q1.6-3 0-6z', 'M7.5 7.5L9 9', 'M16.5 7.5L15 9', 'M16.5 16.5L15 15', 'M7.5 16.5L9 15');
export const SettingsChart = lucide('SettingsChart', 'M5 21v-6', 'M12 21V3', 'M19 21V9');
export const SettingsCloudDownload = lucide('SettingsCloudDownload', 'M12 13v8', 'M8 17l4 4 4-4', 'M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284');
export const SettingsUser = lucide('SettingsUser', 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', circle(12, 7, 4));
export const SettingsUsers = lucide('SettingsUsers', 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', circle(9, 7, 4), 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75');
export const SettingsCard = lucide('SettingsCard', 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M2 10h20');
export const SettingsBlocks = lucide('SettingsBlocks', 'M15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3');
export const SettingsFileText = lucide('SettingsFileText', 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8');
export const SettingsMic = lucide('SettingsMic', 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3');
export const SettingsSend = lucide('SettingsSend', 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z', 'M21.854 2.147l-10.94 10.939');
export const SettingsUpload = lucide('SettingsUpload', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12');
export const SettingsDownload = lucide('SettingsDownload', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3');
export const SettingsSun = lucide('SettingsSun', circle(12, 12, 4), 'M12 2v2', 'M12 20v2', 'M4.93 4.93l1.41 1.41', 'M17.66 17.66l1.41 1.41', 'M2 12h2', 'M20 12h2', 'M6.34 17.66l-1.41 1.41', 'M19.07 4.93l-1.41 1.41');
export const SettingsDevices = lucide('SettingsDevices', 'M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8', 'M10 19v-4', 'M7 19h5', 'M18 12h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z');
export const SettingsInfo = lucide('SettingsInfo', circle(12, 12, 10), 'M12 16v-4', 'M12 8h.01');
export const SettingsDrive = lucide('SettingsDrive', 'M22 12H2', 'M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z', 'M6 16h.01', 'M10 16h.01');
export const SettingsSparkles = lucide('SettingsSparkles', 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z', 'M20 3v4', 'M22 5h-4', 'M4 17v2', 'M5 18H3');
export const SettingsSearch = lucide('SettingsSearch', circle(11, 11, 8), 'M21 21l-4.3-4.3');
export const SettingsX = lucide('SettingsX', 'M18 6L6 18', 'M6 6l12 12');
export const SettingsCopy = lucide('SettingsCopy', 'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2');
export const SettingsChevronDown = lucide('SettingsChevronDown', 'M6 9l6 6 6-6');
