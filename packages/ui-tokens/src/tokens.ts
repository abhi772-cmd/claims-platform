// Token values mirrored from tokens.css. Use these in TS code (e.g., chart colors,
// Tailwind config, inline styles). The CSS variables in tokens.css remain the
// runtime source of truth for the browser; this module is the compile-time mirror.

export const colors = {
  primary: {
    50: '#E8F6F7',
    100: '#C5E9EC',
    200: '#8FD3D8',
    300: '#5DBFC6',
    400: '#30A6AF',
    500: '#009BA6',
    600: '#008F99',
    700: '#00767E',
    800: '#005A60',
    900: '#003E43',
  },
  accent: {
    50: '#FFF6E6',
    100: '#FFE5B0',
    300: '#FFC560',
    500: '#FAA71A',
    600: '#E89412',
    700: '#C77A00',
  },
  neutral: {
    0: '#FFFFFF',
    50: '#F8FAFC',
    100: '#F1F4F8',
    200: '#E4E8EE',
    300: '#CDD3DC',
    400: '#99A2AF',
    500: '#6B7280',
    600: '#4A4D53',
    700: '#363A44',
    800: '#1F232B',
    900: '#0F1116',
  },
  success: { 50: '#E8F7EE', 500: '#2E9E55', 700: '#1F7A40' },
  warning: { 50: '#FFF4E0', 500: '#ED8B00', 700: '#B26500' },
  danger: { 50: '#FDECEC', 500: '#D93B3B', 700: '#A12525' },
  info: { 50: '#E6F2FB', 500: '#1976D2', 700: '#0F4F8E' },
} as const;

export const radius = {
  xs: '4px',
  sm: '6px',
  md: '10px',
  lg: '14px',
  pill: '999px',
} as const;

export const space = {
  0: '0px',
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '20px',
  6: '24px',
  8: '32px',
  10: '40px',
  12: '48px',
  16: '64px',
  20: '80px',
  24: '96px',
} as const;

export const fontSize = {
  xs: '11px',
  sm: '13px',
  base: '14px',
  md: '16px',
  lg: '18px',
  xl: '22px',
  '2xl': '28px',
  '3xl': '36px',
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export const fontFamily = {
  sans: "'Inter', 'DM Sans', 'Segoe UI', Roboto, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  mono: "'JetBrains Mono', 'Fira Code', ui-monospace, 'Cascadia Code', monospace",
} as const;

export const zIndex = {
  base: 0,
  elevated: 10,
  sticky: 100,
  overlay: 200,
  dropdown: 300,
  modal: 400,
  toast: 500,
  tooltip: 600,
} as const;

export const shadow = {
  sm: '0 1px 2px rgba(15, 17, 22, 0.06)',
  md: '0 4px 12px rgba(15, 17, 22, 0.08)',
  lg: '0 12px 32px rgba(15, 17, 22, 0.10)',
  xl: '0 24px 48px rgba(15, 17, 22, 0.14)',
} as const;

export const motion = {
  duration: {
    instant: '50ms',
    fast: '150ms',
    base: '250ms',
    slow: '400ms',
  },
  easing: {
    standard: 'cubic-bezier(0.4, 0.0, 0.2, 1)',
    decelerate: 'cubic-bezier(0.0, 0.0, 0.2, 1)',
    accelerate: 'cubic-bezier(0.4, 0.0, 1, 1)',
  },
} as const;

export const layout = {
  pageMaxWidth: '1440px',
  sidebarWidth: '240px',
  sidebarCollapsed: '64px',
  topbarHeight: '64px',
  pagePadding: '24px',
  pagePaddingMobile: '16px',
} as const;
