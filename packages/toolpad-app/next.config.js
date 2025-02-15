/** @type {import('./src/config').SharedConfig} */
const sharedConfig = {};

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  publicRuntimeConfig: sharedConfig,

  webpack: (config, { isServer }) => {
    if (isServer) {
      // See https://github.com/prisma/prisma/issues/6564#issuecomment-853028373
      config.externals.push('_http_common');
    }
    return config;
  },

  async rewrites() {
    return [
      {
        source: '/deploy/:appId/:path*',
        destination: '/api/deploy/:appId/:path*',
      },
      {
        source: '/app/:appId/:path*',
        destination: '/api/app/:appId/:path*',
      },
    ];
  },

  async redirect() {
    return [
      {
        source: '/release/:path*',
        destination: '/app/:path*',
      },
    ];
  },

  async headers() {
    return [
      {
        source: '/_next/static/chunks/:path*',
        headers: [
          {
            key: 'service-worker-allowed',
            value: '/',
          },
        ],
      },
    ];
  },
};
