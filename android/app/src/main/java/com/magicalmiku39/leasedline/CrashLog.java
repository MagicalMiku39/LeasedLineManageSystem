package com.magicalmiku39.leasedline;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Keeps the stack trace of the last crash so the next launch can show it to the user.
 * Nothing leaves the phone; the user decides whether to copy and send it.
 */
final class CrashLog {
    private static final String PREFS = "crash";
    private static final String KEY_REPORT = "report";

    private CrashLog() {
    }

    static void install(Context context) {
        final Context app = context.getApplicationContext();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        if (previous instanceof Recorder) return;
        Thread.setDefaultUncaughtExceptionHandler(new Recorder(app, previous));
    }

    static String pending(Context context) {
        return prefs(context).getString(KEY_REPORT, null);
    }

    static void clear(Context context) {
        prefs(context).edit().remove(KEY_REPORT).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static final class Recorder implements Thread.UncaughtExceptionHandler {
        private final Context app;
        private final Thread.UncaughtExceptionHandler previous;

        Recorder(Context app, Thread.UncaughtExceptionHandler previous) {
            this.app = app;
            this.previous = previous;
        }

        @Override
        public void uncaughtException(Thread thread, Throwable error) {
            try {
                String report = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(new Date())
                        + "\nApp " + version(app)
                        + "\n" + Build.MANUFACTURER + " " + Build.MODEL
                        + "，Android " + Build.VERSION.RELEASE + "（API " + Build.VERSION.SDK_INT + "）"
                        + "\n线程：" + thread.getName()
                        + "\n\n" + Log.getStackTraceString(error);
                // commit(), not apply(): the process is about to die.
                prefs(app).edit().putString(KEY_REPORT, report).commit();
            } catch (Throwable ignored) {
                // Recording must never hide the original crash.
            }
            if (previous != null) previous.uncaughtException(thread, error);
        }
    }

    private static String version(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }
}
