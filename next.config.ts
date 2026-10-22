import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server (.next/standalone) that the droplet runs with plain
  // `node server.js`. The box has 1 GB of RAM and cannot compile Next, so
  // scripts/deploy.sh builds on the laptop and ships this output.
  output: "standalone",
  // No image optimizer: it needs `sharp`, a native dependency the droplet cannot load.
  images: { unoptimized: true },
  // Loaders read data/destinations/** at run time (the core-rank lane); file tracing only
  // copies what it can see at build time.
  outputFileTracingIncludes: { "/**": ["./data/destinations/**/*.yaml"] },
  poweredByHeader: false,
};

export default nextConfig;
