package com.dshlocal.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Foreground service that owns the two server processes:
 *   harness -> setup.sh harness  -> npx @deepseek-ai/dsh web  (127.0.0.1:3080)
 *   proxy   -> setup.sh proxy    -> node proxy.js gateway     (127.0.0.1:8787, terminal ws 8788)
 * State is mirrored to status-*.json files the dashboard polls.
 */
public class ServerService extends Service {

    static final String ACTION_START_HARNESS = "com.dshlocal.app.START_HARNESS";
    static final String ACTION_STOP_HARNESS = "com.dshlocal.app.STOP_HARNESS";
    static final String ACTION_START_PROXY = "com.dshlocal.app.START_PROXY";
    static final String ACTION_STOP_PROXY = "com.dshlocal.app.STOP_PROXY";

    /** Where the notification tap should land when the user opens the app. */
    static final String TAP_OPEN_CONSOLE = "console";
    static final String TAP_OPEN_TERMINAL = "terminal";
    private static final String PREF_TAP = "notification_tap";

    /** Remember which surface the notification should open (called by MainActivity). */
    static void setTapIntent(Context ctx, String tap) {
        ctx.getSharedPreferences("dsh_prefs", Context.MODE_PRIVATE)
                .edit().putString(PREF_TAP, tap).apply();
    }

    static String getTapIntent(Context ctx) {
        return ctx.getSharedPreferences("dsh_prefs", Context.MODE_PRIVATE)
                .getString(PREF_TAP, TAP_OPEN_CONSOLE);
    }

    private static final String CHANNEL = "dsh_servers";

    private Process harnessProc;
    private Process proxyProc;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "DSH servers",
                NotificationManager.IMPORTANCE_LOW);
        nm.createNotificationChannel(ch);
        startForeground(1, buildNotification());
    }

    /** Notification reflects what's actually running; tap lands on the last-started surface. */
    private Notification buildNotification() {
        boolean h = harnessProc != null, p = proxyProc != null;
        String text;
        if (h && p) text = "Harness :3080 · Gateway :8787 online — tap to open";
        else if (h) text = "Harness :3080 online — tap to open the console";
        else if (p) text = "Gateway :8787 + terminal :8788 online — tap to open";
        else text = "Starting servers…";
        Notification.Builder b;
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        return b.setContentTitle("DSH Local").setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim).setOngoing(true).build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_START_HARNESS.equals(action)) ensureRuntime();
        if (ACTION_START_HARNESS.equals(action)) startHarness();
        else if (ACTION_STOP_HARNESS.equals(action)) stopProc("harness");
        else if (ACTION_START_PROXY.equals(action)) ensureRuntime();
        else if (ACTION_START_PROXY.equals(action)) startProxy();
        else if (ACTION_STOP_PROXY.equals(action)) stopProc("proxy");
        startForeground(1, buildNotification());
        if (harnessProc == null && proxyProc == null) {
            stopForeground(true);
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    /** Copy scripts + web console into place on first run. */
    private void ensureRuntime() {
        try {
            copyAsset("setup.sh", homePath("setup.sh"));
            copyAsset("provision.sh", homePath("provision.sh"));
            copyAsset("dsh-web.js", homePath("dsh-web.js"));
            copyAsset("proxy.js", homePath("proxy.js"));
            copyAsset("web/terminal.html", homePath("web/terminal.html"));
            copyAsset("web/xterm.js", homePath("web/xterm.js"));
            copyAsset("web/xterm.css", homePath("web/xterm.css"));
            copyAsset("web/dsh/index.html", homePath("web/dsh/index.html"));
        } catch (Exception e) {
            status("harness", "error: " + e.getMessage());
        }
    }

    private synchronized void startHarness() {
        if (harnessProc != null) return;
        status("harness", BootstrapInstaller.isInstalled(this)
                && new File(homePath(".dsh-node-ok")).exists() ? "starting" : "installing");
        harnessProc = spawn("harness");
    }

    private synchronized void startProxy() {
        if (proxyProc != null) return;
        status("proxy", "starting");
        proxyProc = spawn("proxy");
    }

    private Process spawn(String which) {
        try {
            ProcessBuilder pb = new ProcessBuilder(
                    prefixPath("bin/sh"), homePath("setup.sh"), which);
            pb.environment().put("PREFIX", BootstrapInstaller.prefixDir(this));
            pb.environment().put("HOME", BootstrapInstaller.homeDir(this));
            pb.environment().put("TMPDIR", BootstrapInstaller.tmpDir(this));
            pb.environment().put("PATH",
                    BootstrapInstaller.prefixDir(this) + "/bin:" + System.getenv("PATH"));
            pb.environment().put("LD_PRELOAD", "");
            pb.environment().put("DSH_FILES", filesDir());
            pb.redirectErrorStream(true);
            Process p = pb.start();
            final String w = which;
            final Process proc = p;
            Thread t = new Thread(() -> {
                try {
                    java.io.InputStream in = proc.getInputStream();
                    byte[] b = new byte[4096];
                    int n;
                    while ((n = in.read(b)) > 0) { /* console visible in Terminal tab */ }
                } catch (Exception ignored) {}
                synchronized (ServerService.this) {
                    if ("harness".equals(w)) harnessProc = null;
                    else proxyProc = null;
                    status(w, "offline");
                }
            });
            t.setDaemon(true);
            t.start();
            return p;
        } catch (Exception e) {
            status(which, "error: " + e.getMessage());
            return null;
        }
    }

    private synchronized void stopProc(String which) {
        Process p = "harness".equals(which) ? harnessProc : proxyProc;
        status(which, "stopping");
        if (p != null) {
            p.destroy();
            // Give it a moment, then force-kill the process group via sh.
            try {
                Runtime.getRuntime().exec(new String[]{
                        prefixPath("bin/sh"), "-c",
                        "pkill -9 -f 'setup.sh " + which + "' 2>/dev/null; true"});
            } catch (Exception ignored) {}
        }
        if ("harness".equals(which)) harnessProc = null;
        else proxyProc = null;
        status(which, "offline");
    }

    @Override
    public void onDestroy() {
        if (harnessProc != null) harnessProc.destroy();
        if (proxyProc != null) proxyProc.destroy();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ---- status files (polled by MainActivity) ----

    static String statusFile(Context ctx, String which) {
        return new File(ctx.getFilesDir(), "status-" + which + ".json").getAbsolutePath();
    }

    private void status(String which, String state) {
        try {
            String json = "{\"state\":\"" + state.replace("\"", "") + "\",\"ts\":"
                    + System.currentTimeMillis() + "}";
            FileOutputStream fo = new FileOutputStream(statusFile(this, which));
            fo.write(json.getBytes("UTF-8"));
            fo.close();
        } catch (Exception ignored) {}
    }

    private String filesDir() { return getFilesDir().getAbsolutePath(); }
    private String filesPath(String rel) { return filesDir() + "/" + rel; }
    private String homePath(String rel) { return BootstrapInstaller.homeDir(this) + "/" + rel; }
    private String prefixPath(String rel) { return BootstrapInstaller.prefixDir(this) + "/" + rel; }

    private void copyAsset(String asset, String dest) throws Exception {
        File out = new File(dest);
        if (out.getParentFile() != null) out.getParentFile().mkdirs();
        try (InputStream in = getAssets().open(asset);
             OutputStream os = new FileOutputStream(out)) {
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) os.write(b, 0, n);
        }
        out.setExecutable(true, true);
        out.setWritable(true, true);
    }
}
