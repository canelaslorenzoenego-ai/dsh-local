package com.dshlocal.app;

import android.content.Context;
import android.content.SharedPreferences;

/** Device-local settings: PIN lock, open-in-app vs chrome. Nothing leaves the phone. */
final class Prefs {
    private static final String NAME = "dsh_prefs";

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    static boolean pinEnabled(Context c) { return sp(c).getBoolean("pin_enabled", false); }
    static String pin(Context c) { return sp(c).getString("pin", ""); }

    static void setPin(Context c, String pin) {
        sp(c).edit().putBoolean("pin_enabled", pin != null && pin.length() >= 4)
                .putString("pin", pin == null ? "" : pin).apply();
    }

    static void disablePin(Context c) {
        sp(c).edit().putBoolean("pin_enabled", false).putString("pin", "").apply();
    }

    /** true = open server UIs inside the app WebView; false = device browser. */
    static boolean openInApp(Context c) { return sp(c).getBoolean("open_in_app", true); }
    static void setOpenInApp(Context c, boolean v) { sp(c).edit().putBoolean("open_in_app", v).apply(); }
}
