/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@claims/contracts', '@claims/error-codes', '@claims/ui-tokens'],
  experimental: {
    typedRoutes: false,
  },
};

module.exports = nextConfig;
