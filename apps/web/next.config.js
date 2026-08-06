/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `standalone` emits a self-contained .next/standalone tree that the
  // production Docker image copies directly. Without this Next.js
  // expects the full node_modules at runtime, which bloats the image
  // from ~150MB to ~1.2GB. See apps/web/Dockerfile.
  output: 'standalone',
  transpilePackages: ['@claims/contracts', '@claims/error-codes', '@claims/ui-tokens'],
  experimental: {
    typedRoutes: false,
  },
};

module.exports = nextConfig;
