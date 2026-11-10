const path = require('node:path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname, '..'),
};

// Optional same-origin routing for the local, shareable preview.
if (process.env.BARD_PREVIEW_API_ORIGIN && process.env.BARD_PREVIEW_MCP_ORIGIN) {
  const api = process.env.BARD_PREVIEW_API_ORIGIN;
  const mcp = process.env.BARD_PREVIEW_MCP_ORIGIN;
  nextConfig.rewrites = async () => [
    { source: '/api/:path*', destination: `${api}/api/:path*` },
    { source: '/uploads/:path*', destination: `${api}/uploads/:path*` },
    { source: '/verify-human', destination: `${api}/verify-human` },
    { source: '/human-link-assets/:path*', destination: `${api}/human-link-assets/:path*` },
    { source: '/mcp', destination: `${mcp}/mcp` },
  ];
  if (process.env.BARD_PREVIEW_HOST) {
    nextConfig.allowedDevOrigins = [process.env.BARD_PREVIEW_HOST];
  }
}

module.exports = nextConfig;
