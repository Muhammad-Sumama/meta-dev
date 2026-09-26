import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // FFmpeg/ffprobe binaries are resolved from node_modules at runtime; they must
  // not be bundled.
  serverExternalPackages: ["ffmpeg-static", "@ffprobe-installer/ffprobe", "yazl"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
