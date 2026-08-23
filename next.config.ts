import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp 0.35 splits code across @img/* packages (@img/colour, platform
  // binaries). Vercel's file tracing missed @img/colour in the Aug 2026
  // deploys, so loading the utilities actions module threw at import time
  // and every action on /utilities failed. Force the whole sharp tree into
  // the traced output for the route that uses it.
  outputFileTracingIncludes: {
    "/utilities": ["node_modules/sharp/**", "node_modules/@img/**"],
  },
  experimental: {
    serverActions: {
      // The add-tenant form accepts lease PDFs up to 20 MB; the default
      // server-action body limit is 1 MB. 25mb leaves headroom for the
      // multipart encoding overhead and the other form fields.
      bodySizeLimit: "25mb",
    },
    // Revisiting a page within 30s serves the client-cached copy instantly
    // instead of re-rendering on the server. Server actions still bust this
    // via revalidatePath, so our own edits always show immediately.
    staleTimes: {
      dynamic: 30,
    },
  },
};

export default nextConfig;
