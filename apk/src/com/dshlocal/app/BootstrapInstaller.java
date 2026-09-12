package com.dshlocal.app;

import android.content.Context;
import android.os.Build;
import android.system.Os;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Extracts the Termux bootstrap archive from APK assets into this app's private
 * data dir, creating a usable Linux prefix without root. Ported from
 * OpenClawAndroid/openclaw-android-assistant BootstrapInstaller.kt, which itself
 * follows Termux's TermuxInstaller: stage -> symlinks -> chmod -> atomic rename.
 */
final class BootstrapInstaller {
    private static final String TERMUX_PREFIX = "/data/data/com.termux/files/usr";

    private BootstrapInstaller() {}

    static String filesDir(Context ctx) { return ctx.getFilesDir().getAbsolutePath(); }
    static String prefixDir(Context ctx) { return filesDir(ctx) + "/usr"; }
    static String homeDir(Context ctx) { return filesDir(ctx) + "/home"; }
    static String tmpDir(Context ctx) { return prefixDir(ctx) + "/tmp"; }

    static boolean isInstalled(Context ctx) {
        return new File(prefixDir(ctx), "bin/sh").exists();
    }

    static synchronized void install(Context ctx, Progress cb) throws Exception {
        String files = filesDir(ctx);
        String prefix = prefixDir(ctx);
        File prefixFile = new File(prefix);
        if (prefixFile.isDirectory() && new File(prefixFile, "bin/sh").exists()) return;

        cb.onProgress("Extracting Linux environment…");
        String staging = files + "/usr-staging";
        File stagingFile = new File(staging);
        if (stagingFile.exists()) deleteRecursive(stagingFile);

        String asset = "bootstrap-" + archName() + ".zip";
        List<String[]> symlinks = new ArrayList<>();
        byte[] buf = new byte[8192];
        try (InputStream in = ctx.getAssets().open(asset);
             ZipInputStream zip = new ZipInputStream(in)) {
            ZipEntry e;
            while ((e = zip.getNextEntry()) != null) {
                if ("SYMLINKS.txt".equals(e.getName())) {
                    BufferedReader r = new BufferedReader(new InputStreamReader(zip));
                    String line;
                    while ((line = r.readLine()) != null) {
                        String[] parts = line.split("←");
                        if (parts.length == 2) {
                            String target = parts[0].trim();
                            String link = parts[1].trim();
                            if (target.startsWith(TERMUX_PREFIX)) {
                                target = target.replace(TERMUX_PREFIX, prefix);
                            }
                            symlinks.add(new String[]{target, staging + "/" + link});
                            File lp = new File(staging + "/" + link);
                            File parent = lp.getParentFile();
                            if (parent != null) ensureParent(parent);
                        }
                    }
                } else {
                    File out = new File(staging, e.getName());
                    if (e.isDirectory()) {
                        ensureParent(out);
                    } else {
                        ensureParent(out.getParentFile());
                        try (FileOutputStream fos = new FileOutputStream(out)) {
                            int n;
                            while ((n = zip.read(buf)) != -1) fos.write(buf, 0, n);
                        }
                        if (shouldBeExec(e.getName())) {
                            Os.chmod(out.getAbsolutePath(), 0b111_000_000); // 0700
                        }
                    }
                }
            }
        }
        if (symlinks.isEmpty()) throw new RuntimeException("No SYMLINKS.txt in bootstrap");

        cb.onProgress("Creating symlinks…");
        for (String[] sl : symlinks) {
            try {
                File lf = new File(sl[1]);
                if (lf.exists() || lf.isDirectory()) deleteRecursive(lf);
                ensureParent(lf.getParentFile());
                Os.symlink(sl[0], sl[1]);
            } catch (Exception ignored) {}
        }

        if (prefixFile.exists()) deleteRecursive(prefixFile);
        if (!stagingFile.renameTo(prefixFile)) {
            throw new RuntimeException("Failed staging->" + prefix);
        }
        new File(homeDir(ctx)).mkdirs();
        new File(tmpDir(ctx)).mkdirs();

        cb.onProgress("Fixing script paths…");
        fixShebangs(prefix);

        cb.onProgress("Configuring package manager…");
        fixTermuxPaths(prefix);
    }

    /**
     * The bootstrap ships scripts with shebangs that cannot execute under our
     * prefix: hardcoded Termux paths (#!/data/data/com.termux/...), env-style
     * (#!/usr/bin/env …) and other FHS paths (/usr/bin, /bin) — none of which
     * exist on Android. Rewrites them to direct interpreters inside our prefix.
     * Scans bin/ AND var/lib/dpkg/info/ — dpkg runs the *.postinst scripts there
     * during `apt install nodejs`, and a dead postinst fails the whole install.
     */
    private static void fixShebangs(String prefix) {
        String[] dirs = {"bin", "var/lib/dpkg/info"};
        for (String dir : dirs) {
            File d = new File(prefix, dir);
            File[] files = d.listFiles();
            if (files == null) continue;
            for (File f : files) {
                if (!f.isFile() || f.length() > 512 * 1024) continue; // scripts only
                try {
                    String s = read(f);
                    if (!s.startsWith("#!")) continue; // binary
                    int nl = s.indexOf('\n');
                    String first = nl >= 0 ? s.substring(0, nl) : s;
                    String body = nl >= 0 ? s.substring(nl + 1) : "";
                    String interp = first.substring(2).trim();
                    String newline;
                    if (interp.startsWith(TERMUX_PREFIX)) {
                        // same interpreter, our prefix
                        newline = "#!" + prefix + interp.substring(TERMUX_PREFIX.length());
                    } else if (interp.startsWith("/usr/bin/env") || interp.startsWith("/bin/env")) {
                        // resolve `env <interpreter>` to the real binary
                        String[] parts = interp.split("\\s+");
                        String name = "sh";
                        for (int i = 1; i < parts.length; i++) {
                            if (!parts[i].startsWith("-")) { name = parts[i]; break; }
                        }
                        File target = new File(prefix, "bin/" + name);
                        newline = "#!" + prefix + "/bin/" + (target.exists() ? name : "sh");
                    } else if (interp.startsWith("/usr/bin/") || interp.startsWith("/bin/")) {
                        String name = interp.substring(interp.lastIndexOf('/') + 1);
                        File target = new File(prefix, "bin/" + name);
                        newline = "#!" + prefix + "/bin/" + (target.exists() ? name : "sh");
                    } else {
                        continue; // already portable
                    }
                    if (body.contains(TERMUX_PREFIX)) body = body.replace(TERMUX_PREFIX, prefix);
                    writeFile(f, newline + "\n" + body);
                } catch (Exception ignored) {}
            }
        }
    }

    /** Rewrite hardcoded Termux paths in apt/dpkg config for our prefix. */
    private static void fixTermuxPaths(String prefix) throws Exception {
        StringBuilder conf = new StringBuilder();
        conf.append("Dir \"/\";\n");
        conf.append("Dir::State \"").append(prefix).append("/var/lib/apt/\";\n");
        conf.append("Dir::State::status \"").append(prefix).append("/var/lib/dpkg/status\";\n");
        conf.append("Dir::Cache \"").append(prefix).append("/var/cache/apt/\";\n");
        conf.append("Dir::Log \"").append(prefix).append("/var/log/apt/\";\n");
        conf.append("Dir::Etc \"").append(prefix).append("/etc/apt/\";\n");
        conf.append("Dir::Etc::SourceList \"").append(prefix).append("/etc/apt/sources.list\";\n");
        conf.append("Dir::Etc::SourceParts \"\";\n");
        conf.append("Dir::Bin::dpkg \"").append(prefix).append("/bin/dpkg\";\n");
        conf.append("Dir::Bin::Methods \"").append(prefix).append("/lib/apt/methods/\";\n");
        conf.append("Dir::Bin::apt-key \"").append(prefix).append("/bin/apt-key\";\n");
        conf.append("Dpkg::Options:: \"--force-configure-any\";\n");
        conf.append("Dpkg::Options:: \"--force-bad-path\";\n");
        conf.append("Dpkg::Options:: \"--instdir=").append(prefix).append("\";\n");
        conf.append("Acquire::AllowInsecureRepositories \"true\";\n");
        writeFile(new File(prefix, "etc/apt/apt.conf"), conf.toString());
        new File(prefix, "var/log/apt").mkdirs();

        File sources = new File(prefix, "etc/apt/sources.list");
        if (sources.exists()) {
            String c = read(sources);
            writeFile(sources, c.replace("https://", "http://").replace("com.termux", "com.dshlocal.app"));
        }
        File status = new File(prefix, "var/lib/dpkg/status");
        if (status.exists()) {
            writeFile(status, read(status).replace(TERMUX_PREFIX, prefix));
        }
        for (String d : new String[]{"var/lib/dpkg/info", "var/lib/dpkg/updates",
                "var/lib/dpkg/triggers", "var/cache/apt/archives/partial",
                "var/lib/apt/lists/partial"}) {
            new File(prefix, d).mkdirs();
        }
        File info = new File(prefix, "var/lib/dpkg/info");
        File[] list = info.listFiles();
        if (list != null) {
            for (File f : list) {
                if (f.getName().endsWith(".list")) {
                    try {
                        String t = read(f);
                        if (t.contains(TERMUX_PREFIX)) writeFile(f, t.replace(TERMUX_PREFIX, prefix));
                    } catch (Exception ignored) {}
                }
            }
        }
    }

    private static boolean shouldBeExec(String name) {
        return name.startsWith("bin/") || name.startsWith("libexec/")
                || name.startsWith("lib/apt/methods/") || name.startsWith("lib/bash/")
                || name.endsWith(".so") || name.contains("/bin/");
    }

    private static String archName() {
        for (String abi : Build.SUPPORTED_ABIS) {
            if ("arm64-v8a".equals(abi)) return "aarch64";
            if ("armeabi-v7a".equals(abi)) return "arm";
            if ("x86_64".equals(abi)) return "x86_64";
            if ("x86".equals(abi)) return "i686";
        }
        throw new RuntimeException("Unsupported ABI");
    }

    private static void ensureParent(File d) {
        if (d != null && !d.isDirectory() && !d.mkdirs() && !d.isDirectory()) {
            throw new RuntimeException("mkdir failed: " + d);
        }
    }

    private static void deleteRecursive(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static String read(File f) throws Exception {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        try (InputStream in = new java.io.FileInputStream(f)) {
            byte[] b = new byte[8192]; int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
        }
        return bo.toString("UTF-8");
    }

    private static void writeFile(File f, String content) throws Exception {
        if (f.getParentFile() != null) ensureParent(f.getParentFile());
        try (FileOutputStream fo = new FileOutputStream(f)) {
            fo.write(content.getBytes("UTF-8"));
        }
    }

    interface Progress { void onProgress(String s); }
}
