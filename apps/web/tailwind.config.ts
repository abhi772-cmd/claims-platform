import type { Config } from 'tailwindcss';

// Tailwind reads CSS variables defined in tokens.css. Adding tokens here only
// is not enough — they must also be in tokens.css for the runtime to resolve.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: 'var(--m3-primary)',
          50: 'var(--color-primary-50)',
          100: 'var(--color-primary-100)',
          200: 'var(--color-primary-200)',
          300: 'var(--color-primary-300)',
          400: 'var(--color-primary-400)',
          500: 'var(--color-primary-500)',
          600: 'var(--color-primary-600)',
          700: 'var(--color-primary-700)',
          800: 'var(--color-primary-800)',
          900: 'var(--color-primary-900)',
        },
        accent: {
          DEFAULT: 'var(--color-accent-500)',
          50: 'var(--color-accent-50)',
          100: 'var(--color-accent-100)',
          300: 'var(--color-accent-300)',
          500: 'var(--color-accent-500)',
          600: 'var(--color-accent-600)',
          700: 'var(--color-accent-700)',
        },
        neutral: {
          0: 'var(--color-neutral-0)',
          50: 'var(--color-neutral-50)',
          100: 'var(--color-neutral-100)',
          200: 'var(--color-neutral-200)',
          300: 'var(--color-neutral-300)',
          400: 'var(--color-neutral-400)',
          500: 'var(--color-neutral-500)',
          600: 'var(--color-neutral-600)',
          700: 'var(--color-neutral-700)',
          800: 'var(--color-neutral-800)',
          900: 'var(--color-neutral-900)',
        },
        success: {
          50: 'var(--color-success-50)',
          500: 'var(--color-success-500)',
          700: 'var(--color-success-700)',
        },
        warning: {
          50: 'var(--color-warning-50)',
          500: 'var(--color-warning-500)',
          700: 'var(--color-warning-700)',
        },
        danger: {
          50: 'var(--color-danger-50)',
          500: 'var(--color-danger-500)',
          700: 'var(--color-danger-700)',
        },
        info: {
          50: 'var(--color-info-50)',
          500: 'var(--color-info-500)',
          700: 'var(--color-info-700)',
        },

        /* ============================================================ */
        /* Material 3 token names (Stitch-generated screens reference   */
        /* these directly: bg-primary, text-on-surface, etc.).          */
        /* Resolves to --m3-* CSS variables in tokens.css.              */
        /* ============================================================ */
        'on-primary': 'var(--m3-on-primary)',
        'primary-container': 'var(--m3-primary-container)',
        'on-primary-container': 'var(--m3-on-primary-container)',
        'primary-fixed': 'var(--m3-primary-fixed)',
        'primary-fixed-dim': 'var(--m3-primary-fixed-dim)',
        'on-primary-fixed': 'var(--m3-on-primary-fixed)',
        'on-primary-fixed-variant': 'var(--m3-on-primary-fixed-variant)',
        'inverse-primary': 'var(--m3-inverse-primary)',
        'surface-tint': 'var(--m3-surface-tint)',

        secondary: {
          DEFAULT: 'var(--m3-secondary)',
          container: 'var(--m3-secondary-container)',
          fixed: 'var(--m3-secondary-fixed)',
          'fixed-dim': 'var(--m3-secondary-fixed-dim)',
        },
        'on-secondary': 'var(--m3-on-secondary)',
        'secondary-container': 'var(--m3-secondary-container)',
        'on-secondary-container': 'var(--m3-on-secondary-container)',
        'secondary-fixed': 'var(--m3-secondary-fixed)',
        'secondary-fixed-dim': 'var(--m3-secondary-fixed-dim)',
        'on-secondary-fixed': 'var(--m3-on-secondary-fixed)',
        'on-secondary-fixed-variant': 'var(--m3-on-secondary-fixed-variant)',

        tertiary: 'var(--m3-tertiary)',
        'on-tertiary': 'var(--m3-on-tertiary)',
        'tertiary-container': 'var(--m3-tertiary-container)',
        'on-tertiary-container': 'var(--m3-on-tertiary-container)',
        'tertiary-fixed': 'var(--m3-tertiary-fixed)',
        'tertiary-fixed-dim': 'var(--m3-tertiary-fixed-dim)',
        'on-tertiary-fixed': 'var(--m3-on-tertiary-fixed)',
        'on-tertiary-fixed-variant': 'var(--m3-on-tertiary-fixed-variant)',

        error: {
          DEFAULT: 'var(--m3-error)',
          container: 'var(--m3-error-container)',
        },
        'on-error': 'var(--m3-on-error)',
        'error-container': 'var(--m3-error-container)',
        'on-error-container': 'var(--m3-on-error-container)',

        background: 'var(--m3-background)',
        'on-background': 'var(--m3-on-background)',
        surface: 'var(--m3-surface)',
        'on-surface': 'var(--m3-on-surface)',
        'surface-variant': 'var(--m3-surface-variant)',
        'on-surface-variant': 'var(--m3-on-surface-variant)',
        'surface-dim': 'var(--m3-surface-dim)',
        'surface-bright': 'var(--m3-surface-bright)',
        'surface-container-lowest': 'var(--m3-surface-container-lowest)',
        'surface-container-low': 'var(--m3-surface-container-low)',
        'surface-container': 'var(--m3-surface-container)',
        'surface-container-high': 'var(--m3-surface-container-high)',
        'surface-container-highest': 'var(--m3-surface-container-highest)',
        'inverse-surface': 'var(--m3-inverse-surface)',
        'inverse-on-surface': 'var(--m3-inverse-on-surface)',

        outline: 'var(--m3-outline)',
        'outline-variant': 'var(--m3-outline-variant)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
        h1: ['var(--font-sans)'],
        h2: ['var(--font-sans)'],
        h3: ['var(--font-sans)'],
        body: ['var(--font-sans)'],
        eyebrow: ['var(--font-sans)'],
      },
      fontSize: {
        // Login-canonical scale. Eyebrow is 12px medium 0.04em tracking
        // uppercase — the single most consistent recipe across the app.
        eyebrow: ['12px', { letterSpacing: '0.04em', fontWeight: '500' }],
        'body-sm': ['13px', { lineHeight: '1.5', fontWeight: '400' }],
        body: ['14.5px', { lineHeight: '1.6', fontWeight: '400' }],
        h3: ['22px', { lineHeight: '1.4', letterSpacing: '-0.01em', fontWeight: '600' }],
        h2: ['28px', { lineHeight: '1.3', letterSpacing: '-0.015em', fontWeight: '600' }],
        h1: ['36px', { lineHeight: '1.15', letterSpacing: '-0.02em', fontWeight: '700' }],
        'h1-mobile': ['28px', { lineHeight: '1.2', fontWeight: '700' }],
      },
      spacing: {
        unit: '4px',
        gutter: '24px',
        'margin-mobile': '16px',
        'margin-desktop': '40px',
        'container-max': '1440px',
      },
      borderRadius: {
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        base: 'var(--radius-base)',
        md: 'var(--radius-md)',
        cta: 'var(--radius-cta)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        'glass-card': 'var(--radius-glass-card)',
        pill: 'var(--radius-pill)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        modal: 'var(--shadow-modal)',
        'glass-card': 'var(--shadow-glass-card)',
        'cta-amber': 'var(--shadow-cta-amber)',
      },
      letterSpacing: {
        h1: 'var(--tracking-h1)',
        h2: 'var(--tracking-h2)',
        eyebrow: 'var(--tracking-eyebrow)',
      },
    },
  },
  plugins: [],
};

export default config;
