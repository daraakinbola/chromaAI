import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8000/:path*",
      },
    ];
  },

  webpack: (config, { isServer }) => {
    // Enable async WebAssembly — required by libraw-wasm and onnxruntime-web (PRD §7).
    config.experiments = { ...config.experiments, asyncWebAssembly: true };

    // Copy .wasm files as file assets so they are served at a stable URL.
    // This lets libraw-wasm and onnxruntime-web resolve their WASM binaries at runtime.
    config.module.rules.push({
      test: /\.wasm$/,
      type: "asset/resource",
    });

    if (isServer) {
      // Exclude browser-only packages from the server (SSR) bundle.
      // These are only used inside Web Workers which run in the browser.
      const browserOnlyPackages = [
        "@xenova/transformers",
        "onnxruntime-web",
        "libraw-wasm",
      ];
      const existingExternals = Array.isArray(config.externals)
        ? config.externals
        : config.externals ? [config.externals] : [];
      config.externals = [...existingExternals, ...browserOnlyPackages];
    }

    return config;
  },
};

export default nextConfig;
