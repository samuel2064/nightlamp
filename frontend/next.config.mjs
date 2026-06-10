/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@trpc/server', '@trpc/client', '@trpc/react-query'],
  images: {
    unoptimized: true,
  },
}

export default nextConfig
