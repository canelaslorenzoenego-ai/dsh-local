import React from "react";
import { AlertCircle, ExternalLink, Download } from "lucide-react";

/**
 * Integration integrity guard — wraps critical React bootstrap with a graceful
 * failure message if the Vite build, chunks, or dependencies are broken.
 *
 * This file is intentionally minimal: it avoids any heavy imports, uses only
 * STATIC content, and will render even if React is unavailable.
 */
export function IntegrationWarningFallback() {
  return (
    <div
      style={{
        all: "unset",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        minHeight: "100vh",
        padding: 24,
        color: "#E8EDF7",
        background: "#0B0E14",
        fontFamily: "system-ui, -apple-system, sans-serif",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: 20,
          background: "rgba(244, 91, 105, 0.12)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid rgba(244, 91, 105, 0.35)",
        }}
      >
        <AlertCircle
          style={{
            width: 32,
            height: 32,
            color: "#F45B69",
          }}
          strokeWidth={1.5}
        />
      </div>

      <h1
        style={{
          margin: 0,
          fontSize: "clamp(20px, 4vw, 32px)",
          fontWeight: 700,
          maxWidth: 620,
          lineHeight: 1.2,
        }}
      >
        The DSH Local website couldn't fully load
      </h1>

      <p
        style={{
          margin: 0,
          fontSize: 15,
          color: "#8B96AC",
          lineHeight: 1.6,
          maxWidth: 520,
        }}
      >
        The page should be live at this address, but something in the build
        process failed. Try refreshing the page — if the problem persists, the
        mobile app is still fully functional and the download link below works.
      </p>

      <div
        style={{
          marginTop: 8,
          color: "#8B96AC",
          fontSize: 13,
          lineHeight: 1.6,
          maxWidth: 480,
        }}
      >
        <strong>Did this happen after an update?</strong> The release APK is
        always available directly from the GitHub releases page. If the download
        button below is broken, visit{" "}
        <a
          href="https://github.com/canelaslorenzoenego-ai/dsh-local/releases"
          style={{
            color: "#8FA6FF",
            textDecoration: "none",
          }}
          target="_blank"
          rel="noopener noreferrer"
        >
          the releases page <ExternalLink style={{ display: "inline", verticalAlign: "text-bottom", marginLeft: 4 }} />
        </a>
        and install the APK from there.
      </div>

      <a
        href="https://raw.githubusercontent.com/canelaslorenzoenego-ai/dsh-local/main/public/downloads/dsh-local-v2.7.0.apk"
        download
        style={{
          marginTop: 8,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 20px",
          background: "#4D6BFE",
          color: "#fff",
          borderRadius: 12,
          fontSize: 14,
          fontWeight: 600,
          textDecoration: "none",
          boxShadow: "0 6px 20px rgba(77, 107, 254, 0.35)",
          border: "none",
          cursor: "pointer",
        }}
      >
        <Download style={{ width: 16, height: 16 }} strokeWidth={2} />
        Download APK (offline)
      </a>

      <p
        style={{
          margin: "16px 0 0",
          fontSize: 11,
          color: "#5A6680",
          maxWidth: 460,
        }}
      >
        We know this is frustrating. The issue is not your device — the site
        build failed, not the mobile app. Try again later or contact us if the
        problem continues.
      </p>
    </div>
  );
}
