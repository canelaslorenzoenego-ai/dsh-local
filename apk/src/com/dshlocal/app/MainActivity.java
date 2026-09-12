package com.dshlocal.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.ViewFlipper;
import android.view.animation.Animation;
import android.view.animation.AnimationUtils;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * V2.2 native dashboard. Tabs: Dashboard (two server cards + env badge),
 * Terminal (xterm.js), Settings (open-in-app, PIN, gateway notes).
 * Server polling includes a tiny HTTP probe so the UI shows live latency.
 */
public class MainActivity extends Activity {

    private static final int HARNESS_PORT = 3080;
    private static final int PROXY_PORT = 8787;
    private static final int TERM_PORT = 8788;

    private TextView envDot, envText;
    private TextView statusDotH, statusTextH, statusSubH, statusDotP, statusTextP, statusSubP;
    private LinearLayout chipH, chipP;
    private Button btnHarness, btnOpenH, btnProxy, btnOpenP;
    private TextView tabDash, tabTerm, tabSet;
    private Switch swOpenInApp;
    private EditText etPin;
    private TextView tvPinState;
    private ViewFlipper flipper;
    private WebView terminalWebView;
    private boolean terminalLoaded = false;
    private boolean wantHarness = false, wantProxy = false;
    private boolean bootstrapping = false;
    private Vibrator vib;
    private ProgressBar progH;
    private Animation pulse;
    private final Handler handler = new Handler(Looper.getMainLooper());

    // session link card
    private LinearLayout sessCard, sessLoading;
    private TextView sessLinkView, sessState, sessDot;
    private Button btnCopyLink, btnRotate;
    private String cachedLink = null;
    private String cachedToken = null;
    private String terminalTokenLoaded = null;
    private String statusSubTagH = null;

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            new Thread(() -> {
                final long t0 = System.currentTimeMillis();
                final boolean hUp = isUp(HARNESS_PORT);
                final long t1 = System.currentTimeMillis();
                final boolean pUp = isUp(PROXY_PORT);
                final long t2 = System.currentTimeMillis();
                final long hMs = hUp ? (t1 - t0) : -1;
                final long pMs = pUp ? (t2 - t1) : -1;
                final String hState = readStatus("harness");
                final String pState = readStatus("proxy");
                final String link = hUp ? fetchSessionLink() : null;
                handler.post(() -> {
                    final String toolCount = hUp ? fetchToolCount() : null;
                    applyServer("harness", hUp, hState, wantHarness, hMs,
                            statusDotH, statusTextH, statusSubH, btnHarness, btnOpenH,
                            "dsh · DeepSeek Harness", "http://127.0.0.1:3080");
                    if (hUp && toolCount != null && !toolCount.equals(statusSubTagH)) {
                        statusSubTagH = toolCount;
                        statusSubH.setText("dsh · DeepSeek Harness · " + toolCount + " tools live");
                    } else if (!hUp) {
                        statusSubTagH = null;
                    }
                    applyServer("proxy", pUp, pState, wantProxy, pMs,
                            statusDotP, statusTextP, statusSubP, btnProxy, btnOpenP,
                            "gateway + terminal", "http://127.0.0.1:8787");
                    applyEnv();
                    applySession(hUp, link);
                });
            }).start();
            handler.postDelayed(this, 3000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        vib = (Vibrator) getSystemService(VIBRATOR_SERVICE);

        if (Prefs.pinEnabled(this) && Prefs.pin(this).length() >= 4) {
            getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE,
                    WindowManager.LayoutParams.FLAG_SECURE);
            requireUnlock();
        }

        pulse = AnimationUtils.loadAnimation(this, R.anim.pulse);

        bindViews();
        setTab(0);
        handler.post(poll);
        overridePendingTransition(R.anim.fade_in, R.anim.fade_out);

        // First open: extract the embedded Linux environment automatically.
        if (!BootstrapInstaller.isInstalled(this)) {
            installBootstrap(null);
        }
    }

    private void bindViews() {
        envDot = findViewById(R.id.envDot);
        envText = findViewById(R.id.envText);
        statusDotH = findViewById(R.id.statusDotH);
        statusTextH = findViewById(R.id.statusTextH);
        statusSubH = findViewById(R.id.statusSubH);
        statusDotP = findViewById(R.id.statusDotP);
        statusTextP = findViewById(R.id.statusTextP);
        statusSubP = findViewById(R.id.statusSubP);
        chipH = findViewById(R.id.chipH);
        chipP = findViewById(R.id.chipP);
        progH = findViewById(R.id.progH);
        btnHarness = findViewById(R.id.btnHarness);
        btnOpenH = findViewById(R.id.btnOpenH);
        btnProxy = findViewById(R.id.btnProxy);
        btnOpenP = findViewById(R.id.btnOpenP);
        tabDash = findViewById(R.id.tabDash);
        tabTerm = findViewById(R.id.tabTerm);
        tabSet = findViewById(R.id.tabSet);
        flipper = findViewById(R.id.flipper);
        swOpenInApp = findViewById(R.id.swOpenInApp);
        etPin = findViewById(R.id.etPin);
        tvPinState = findViewById(R.id.tvPinState);
        sessCard = findViewById(R.id.sessCard);
        sessLoading = findViewById(R.id.sessLoading);
        sessLinkView = findViewById(R.id.sessLink);
        sessState = findViewById(R.id.sessState);
        sessDot = findViewById(R.id.sessDot);
        btnCopyLink = findViewById(R.id.btnCopyLink);
        btnRotate = findViewById(R.id.btnRotate);

        btnHarness.setOnClickListener(v -> { haptic(); toggleServer("harness"); });
        btnProxy.setOnClickListener(v -> { haptic(); toggleServer("proxy"); });
        btnOpenH.setOnClickListener(v -> openConsole());
        btnOpenP.setOnClickListener(v -> openTerminal());

        btnCopyLink.setOnClickListener(v -> {
            haptic();
            if (cachedLink == null) { toast("Link not ready yet"); return; }
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("dsh session link", cachedLink));
            toast("Session link copied — paste it into any browser on this device");
        });
        btnRotate.setOnClickListener(v -> {
            haptic();
            rotateSession();
        });

        tabDash.setOnClickListener(v -> { haptic(); setTab(0); });
        tabTerm.setOnClickListener(v -> { haptic(); setTab(1); ensureTerminal(); });
        tabSet.setOnClickListener(v -> { haptic(); setTab(2); });

        swOpenInApp.setChecked(Prefs.openInApp(this));
        swOpenInApp.setOnCheckedChangeListener((b, checked) -> Prefs.setOpenInApp(this, checked));
        findViewById(R.id.btnSavePin).setOnClickListener(v -> {
            String p = etPin.getText().toString().trim();
            if (p.length() < 4) { toast("PIN must be at least 4 digits"); return; }
            Prefs.setPin(this, p);
            etPin.setText("");
            refreshPinUi();
            toast("PIN enabled — app is now private");
        });
        findViewById(R.id.btnClearPin).setOnClickListener(v -> {
            Prefs.disablePin(this);
            refreshPinUi();
            toast("PIN removed");
        });
        refreshPinUi();
    }

    private void rotateSession() {
        new Thread(() -> {
            String newLink = null;
            try {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                        new java.net.URL("http://127.0.0.1:" + HARNESS_PORT + "/api/session/rotate").openConnection();
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("Authorization", "Bearer " + (cachedToken == null ? "" : cachedToken));
                c.setConnectTimeout(1200);
                c.setReadTimeout(1200);
                c.getOutputStream().write("{}".getBytes("UTF-8"));
                if (c.getResponseCode() == 200) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    try (InputStream in = c.getInputStream()) {
                        byte[] b = new byte[2048];
                        int n;
                        while ((n = in.read(b)) > 0) bo.write(b, 0, n);
                    }
                    JSONObject o = new JSONObject(bo.toString("UTF-8"));
                    newLink = o.optString("link", null);
                    cachedToken = o.optString("token", cachedToken);
                }
            } catch (Exception ignored) {}
            final String fl = newLink;
            handler.post(() -> {
                if (fl != null) {
                    cachedLink = fl;
                    sessLinkView.setText(fl);
                    toast("Token rotated — old links no longer work");
                } else {
                    toast("Could not rotate — is the harness online?");
                }
            });
        }).start();
    }

    /** Live toolset size for the harness card subtitle. */
    private String fetchToolCount() {
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                    new java.net.URL("http://127.0.0.1:" + HARNESS_PORT + "/api/status?token="
                            + (cachedToken == null ? "" : cachedToken)).openConnection();
            c.setConnectTimeout(900);
            c.setReadTimeout(900);
            if (c.getResponseCode() != 200) return null;
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] b = new byte[2048];
                int n;
                while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            }
            return String.valueOf(new JSONObject(bo.toString("UTF-8")).optInt("tools", -1));
        } catch (Exception e) {
            return null;
        }
    }

    /** Read the session link straight from the harness API (like the console URL dsh prints). */
    private String fetchSessionLink() {
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                    new java.net.URL("http://127.0.0.1:" + HARNESS_PORT + "/api/session").openConnection();
            c.setConnectTimeout(900);
            c.setReadTimeout(900);
            if (c.getResponseCode() != 200) return null;
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] b = new byte[2048];
                int n;
                while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            }
            JSONObject o = new JSONObject(bo.toString("UTF-8"));
            cachedToken = o.optString("token", null);
            return o.optString("link", null);
        } catch (Exception e) {
            return null;
        }
    }

    private void applySession(boolean up, String link) {
        if (sessCard == null) return;
        if (up && link != null) {
            sessCard.setVisibility(View.VISIBLE);
            sessLoading.setVisibility(View.GONE);
            sessLinkView.setText(link);
            cachedLink = link;
            sessState.setText(R.string.session_active);
            sessState.setTextColor(0xFF2FD575);
            sessDot.setTextColor(0xFF2FD575);
            btnCopyLink.setEnabled(true); btnCopyLink.setAlpha(1f);
            btnRotate.setEnabled(true); btnRotate.setAlpha(1f);
            // keep the in-app terminal authenticated with the current token
            if (terminalWebView != null && cachedToken != null
                    && !cachedToken.equals(terminalTokenLoaded)) {
                terminalTokenLoaded = cachedToken;
                terminalWebView.loadUrl("http://127.0.0.1:" + TERM_PORT + "/?token=" + cachedToken);
            }
        } else {
            boolean starting = wantHarness && !up;
            if (starting) {
                sessCard.setVisibility(View.VISIBLE);
                sessLoading.setVisibility(View.VISIBLE);
                sessLinkView.setText("");
                sessState.setText(R.string.session_booting);
                sessState.setTextColor(0xFFF5B942);
                sessDot.setTextColor(0xFFF5B942);
            } else if (!bootstrapping && !wantHarness) {
                sessCard.setVisibility(View.GONE);
            }
        }
    }

    private void haptic() {
        if (vib == null) return;
        try {
            vib.vibrate(VibrationEffect.createOneShot(16, VibrationEffect.DEFAULT_AMPLITUDE));
        } catch (Exception ignored) {}
    }

    private void applyEnv() {
        if (bootstrapping) return; // install flow owns the badge text
        if (BootstrapInstaller.isInstalled(this)) {
            envDot.setTextColor(0xFF2FD575);
            envText.setText("env ✓");
            envText.setTextColor(0xFF2FD575);
        } else {
            envDot.setTextColor(0xFFF5B942);
            envText.setText("env · missing");
            envText.setTextColor(0xFFF5B942);
        }
    }

    private void refreshPinUi() {
        boolean on = Prefs.pinEnabled(this) && Prefs.pin(this).length() >= 4;
        tvPinState.setText(on ? "PIN lock: ON — app asks for your PIN at launch"
                : "PIN lock: OFF — anyone holding the phone can open this app");
        tvPinState.setTextColor(on ? 0xFF2FD575 : 0xFF8B96AC);
    }

    private void requireUnlock() {
        final EditText et = new EditText(this);
        et.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        et.setHint("PIN");
        AlertDialog d = new AlertDialog.Builder(this)
                .setTitle(R.string.pin_title)
                .setView(et)
                .setCancelable(false)
                .create();
        d.setButton(AlertDialog.BUTTON_POSITIVE, "Unlock", (dlg, w) -> {
            if (et.getText().toString().equals(Prefs.pin(this))) {
                dlg.dismiss();
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            } else {
                Toast.makeText(this, R.string.pin_wrong, Toast.LENGTH_SHORT).show();
                requireUnlock();
            }
        });
        d.show();
    }

    private void setTab(int i) {
        int prev = flipper.getDisplayedChild();
        flipper.setInAnimation(this, i > prev ? R.anim.slide_in_right : R.anim.slide_in_left);
        flipper.setOutAnimation(this, i > prev ? R.anim.slide_out_left : R.anim.slide_out_right);
        flipper.setDisplayedChild(i);
        tabDash.setBackgroundResource(i == 0 ? R.drawable.tab_active : android.graphics.Color.TRANSPARENT);
        tabTerm.setBackgroundResource(i == 1 ? R.drawable.tab_active : android.graphics.Color.TRANSPARENT);
        tabSet.setBackgroundResource(i == 2 ? R.drawable.tab_active : android.graphics.Color.TRANSPARENT);
        int active = 0xFFFFFFFF, inactive = 0xFF8B96AC;
        tabDash.setTextColor(i == 0 ? active : inactive);
        tabTerm.setTextColor(i == 1 ? active : inactive);
        tabSet.setTextColor(i == 2 ? active : inactive);
    }

    private void ensureTerminal() {
        if (terminalLoaded) return;
        terminalLoaded = true;
        terminalWebView = new WebView(this);
        terminalWebView.setBackgroundColor(Color.parseColor("#0B0E14"));
        WebSettings s = terminalWebView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        terminalWebView.setWebViewClient(new LocalAssetWebViewClient());
        // load with the session token once known; reload automatically when the link arrives
        terminalWebView.loadUrl("http://127.0.0.1:" + TERM_PORT + "/");
        ViewGroup holder = findViewById(R.id.terminalContainer);
        holder.addView(terminalWebView, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void toggleServer(String which) {
        boolean wanted = "harness".equals(which) ? wantHarness : wantProxy;
        if (wanted) stopServer(which); else startServer(which);
    }

    private void startServer(String which) {
        if (!BootstrapInstaller.isInstalled(this)) {
            installBootstrap(which);
            return;
        }
        String action;
        if ("harness".equals(which)) {
            action = ServerService.ACTION_START_HARNESS;
            wantHarness = true;
            ServerService.setTapIntent(this, ServerService.TAP_OPEN_CONSOLE);
        } else {
            action = ServerService.ACTION_START_PROXY;
            wantProxy = true;
            ServerService.setTapIntent(this, ServerService.TAP_OPEN_TERMINAL);
        }
        startService(new Intent(this, ServerService.class).setAction(action));
        toast(("harness".equals(which) ? "Harness" : "Proxy") + " starting…");
    }

    private void stopServer(String which) {
        String action;
        if ("harness".equals(which)) { action = ServerService.ACTION_STOP_HARNESS; wantHarness = false; }
        else { action = ServerService.ACTION_STOP_PROXY; wantProxy = false; }
        startService(new Intent(this, ServerService.class).setAction(action));
    }

    private void installBootstrap(final String thenStart) {
        if (bootstrapping) return;
        bootstrapping = true;
        btnHarness.setEnabled(false);
        btnProxy.setEnabled(false);
        envDot.setTextColor(0xFFF5B942);
        envText.setText("env · setting up");
        envText.setTextColor(0xFFF5B942);
        statusDotH.setVisibility(View.VISIBLE);
        statusDotH.setTextColor(0xFFF5B942);
        if (progH != null) progH.setVisibility(View.VISIBLE);
        statusTextH.setText("Preparing first run…");
        statusTextH.setTextColor(0xFFF5B942);
        statusSubH.setText("Extracting embedded Linux — one time, ~30s");
        new Thread(() -> {
            try {
                BootstrapInstaller.install(this, s ->
                        handler.post(() -> statusSubH.setText(s)));
                handler.post(() -> {
                    bootstrapping = false;
                    btnHarness.setEnabled(true);
                    btnProxy.setEnabled(true);
                    if (progH != null) progH.setVisibility(View.GONE);
                    statusDotH.clearAnimation();
                    envDot.setTextColor(0xFF2FD575);
                    envText.setText("env ✓");
                    envText.setTextColor(0xFF2FD575);
                    if (thenStart != null) {
                        startServer(thenStart);
                    } else {
                        statusDotH.setVisibility(View.INVISIBLE);
                        statusTextH.setText(R.string.harness_name);
                        statusTextH.setTextColor(0xFFE8EDF7);
                        statusSubH.setText("Environment ready — press Start when you want it");
                        Toast.makeText(this, "Linux environment ready", Toast.LENGTH_SHORT).show();
                    }
                });
            } catch (Exception e) {
                handler.post(() -> {
                    bootstrapping = false;
                    btnHarness.setEnabled(true);
                    btnProxy.setEnabled(true);
                    if (progH != null) progH.setVisibility(View.GONE);
                    statusDotH.clearAnimation();
                    statusDotH.setTextColor(0xFFF45B69);
                    statusTextH.setText("Install failed");
                    statusTextH.setTextColor(0xFFF45B69);
                    statusSubH.setText(e.getMessage());
                    Toast.makeText(this, "Bootstrap failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    private void openConsole() {
        new Thread(() -> {
            final boolean up = isUp(HARNESS_PORT);
            String l = up ? fetchSessionLink() : null;
            if (l == null) l = "http://127.0.0.1:" + HARNESS_PORT + "/";
            final String link = l;
            runOnUiThread(() -> {
                if (!up) { toast("Harness not online yet — press Start first"); return; }
                if (Prefs.openInApp(this)) openConsoleInApp();
                else openUrl(link, "console");
            });
        }).start();
    }

    /** Full-screen in-app console with the token injected (no browser hop). */
    private void openConsoleInApp() {
        WebView web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0B0E14"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setWebViewClient(new LocalAssetWebViewClient());
        web.loadUrl("http://127.0.0.1:" + HARNESS_PORT + "/#token="
                + (cachedToken == null ? "" : cachedToken));
        AlertDialog dlg = new AlertDialog.Builder(this, android.R.style.Theme_Material_NoActionBar)
                .setTitle("DSH Console")
                .setView(web)
                .setPositiveButton("Close", null)
                .create();
        dlg.show();
        dlg.getWindow().setLayout(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        dlg.setOnDismissListener(d -> web.destroy());
    }

    private void openTerminal() {
        new Thread(() -> {
            final boolean up = isUp(TERM_PORT);
            String flink = null;
            if (up) {
                if (cachedToken == null) fetchSessionLink();
                flink = "http://127.0.0.1:" + TERM_PORT + "/?token=" + (cachedToken == null ? "" : cachedToken);
            }
            final String link = flink;
            runOnUiThread(() -> {
                if (!up) { toast("Terminal not online yet — start the Proxy Gateway first"); return; }
                openUrl(link, "terminal");
            });
        }).start();
    }

    private void openUrl(String url, String what) {
        if (Prefs.openInApp(this)) {
            openInApp(url, what);
        } else {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception e) {
                toast("No browser found");
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void openInApp(String url, String what) {
        WebView web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0B0E14"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setWebViewClient(new LocalAssetWebViewClient());
        web.loadUrl(url);

        AlertDialog dlg = new AlertDialog.Builder(this, android.R.style.Theme_Material_NoActionBar)
                .setTitle(("console".equals(what) ? "DSH Console" : "Terminal"))
                .setView(web)
                .setPositiveButton("Close", null)
                .create();
        dlg.show();
        dlg.getWindow().setLayout(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        dlg.setOnDismissListener(d -> web.destroy());
    }

    /** Serve /web/* for the terminal page from APK assets when the server misses them. */
    private class LocalAssetWebViewClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
            Uri u = req.getUrl();
            String path = u.getPath();
            if ("127.0.0.1".equals(u.getHost()) && u.getPort() == TERM_PORT
                    && path != null && path.startsWith("/web/")) {
                String asset = path.substring("/web/".length());
                try {
                    String mime = asset.endsWith(".js") ? "text/javascript"
                            : asset.endsWith(".css") ? "text/css" : "text/plain";
                    return new WebResourceResponse(mime, null, getAssets().open("web/" + asset));
                } catch (Exception e) { return null; }
            }
            return null;
        }
    }

    private void applyServer(String which, boolean up, String state, boolean wanted, long ms,
                             TextView dot, TextView title, TextView sub, Button toggle, Button open,
                             String subOffline, String subOnline) {
        if (up) {
            dot.setTextColor(0xFF2FD575);
            dot.setVisibility(View.VISIBLE);
            dot.clearAnimation();
            if ("harness".equals(which) && progH != null) progH.setVisibility(View.GONE);
            title.setText(ms >= 0 ? ("Online · " + ms + "ms") : "Online");
            title.setTextColor(0xFF2FD575);
            sub.setText(subOnline);
            toggle.setText(R.string.stop);
            open.setEnabled(true);
            open.setAlpha(1f);
        } else if (wanted && ("installing".equals(state) || "starting".equals(state))) {
            dot.setTextColor(0xFFF5B942);
            dot.setVisibility(View.VISIBLE);
            if (dot.getAnimation() == null) dot.startAnimation(pulse);
            if ("harness".equals(which) && progH != null) progH.setVisibility(View.VISIBLE);
            title.setText(R.string.state_starting);
            title.setTextColor(0xFFF5B942);
            sub.setText("harness".equals(which)
                    ? "First run installs Node.js + dsh — 5–10 min, watch Terminal"
                    : "Booting gateway…");
            toggle.setText(R.string.stop);
            open.setEnabled(false);
            open.setAlpha(0.45f);
        } else if (state != null && state.startsWith("error:")) {
            // Crash with diagnostics: red dot + last line of server output on the card.
            dot.clearAnimation();
            dot.setVisibility(View.VISIBLE);
            dot.setTextColor(0xFFF45B69);
            if ("harness".equals(which) && progH != null) progH.setVisibility(View.GONE);
            title.setText("Failed");
            title.setTextColor(0xFFF45B69);
            String msg = state.substring(6).trim();
            sub.setText(msg.isEmpty() ? "process exited — check Terminal tab" : msg);
            sub.setTextColor(0xFFF45B69);
            toggle.setText(R.string.start);
            open.setEnabled(false);
            open.setAlpha(0.45f);
        } else {
            dot.clearAnimation();
            dot.setVisibility(View.INVISIBLE);
            if ("harness".equals(which) && progH != null) progH.setVisibility(View.GONE);
            title.setText(R.string.state_offline);
            title.setTextColor(0xFFE8EDF7);
            sub.setText(subOffline);
            sub.setTextColor(0xFF8B96AC);
            toggle.setText(R.string.start);
            open.setEnabled(false);
            open.setAlpha(0.45f);
        }
    }

    private String readStatus(String which) {
        try (InputStream in = new FileInputStream(
                new File(getFilesDir(), "status-" + which + ".json"))) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] b = new byte[512];
            int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            return new JSONObject(bo.toString("UTF-8")).optString("state", "");
        } catch (Exception e) {
            return "";
        }
    }

    private static boolean isUp(int port) {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("127.0.0.1", port), 700);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void toast(String m) {
        Toast.makeText(this, m, Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(poll);
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(poll);
        // Notification tap should land where the user expects (console or terminal)
        if (ServerService.TAP_OPEN_TERMINAL.equals(ServerService.getTapIntent(this))
                && isUp(TERM_PORT) && flipper.getDisplayedChild() != 1) {
            setTab(1);
            ensureTerminal();
        }
    }
}
