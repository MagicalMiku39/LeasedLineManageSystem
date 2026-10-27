package com.magicalmiku39.leasedline;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import java.util.Locale;

/**
 * The server address and the certificate the user confirmed for it.
 * The pin is either a SHA-256 fingerprint ("AA:BB:...") of the server's own certificate,
 * or {@link #SYSTEM_TRUST} when the server presents a certificate Android already trusts.
 */
final class ServerConfig {
    static final String SYSTEM_TRUST = "system";

    private static final String PREFS = "server";
    private static final String KEY_URL = "url";
    private static final String KEY_PIN = "pin";

    private final SharedPreferences prefs;

    ServerConfig(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    String url() {
        return prefs.getString(KEY_URL, null);
    }

    String pin() {
        return prefs.getString(KEY_PIN, null);
    }

    boolean isReady() {
        return url() != null && pin() != null;
    }

    String origin() {
        String url = url();
        return url == null ? null : originOf(url);
    }

    void save(String url, String pin) {
        prefs.edit().putString(KEY_URL, url).putString(KEY_PIN, pin).apply();
    }

    void forgetPin() {
        prefs.edit().remove(KEY_PIN).apply();
    }

    /**
     * Accepts "host:port", "https://host:port" or a full https URL. Plain http is refused.
     *
     * @throws IllegalArgumentException with a message for the user
     */
    static String normalize(String input) {
        String text = input == null ? "" : input.trim();
        if (text.isEmpty()) throw new IllegalArgumentException("请输入服务器地址");
        if (!text.contains("://")) text = "https://" + text;
        Uri uri = Uri.parse(text);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"https".equals(scheme)) throw new IllegalArgumentException("只支持 https:// 地址");
        String host = uri.getHost();
        if (host == null || host.isEmpty()) throw new IllegalArgumentException("地址格式不正确");
        StringBuilder url = new StringBuilder("https://").append(host.toLowerCase(Locale.ROOT));
        if (uri.getPort() > 0) url.append(':').append(uri.getPort());
        String path = uri.getPath();
        if (path != null && !path.isEmpty() && !"/".equals(path)) {
            url.append(path.endsWith("/") ? path.substring(0, path.length() - 1) : path);
        }
        return url.toString();
    }

    static String originOf(String url) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        int port = uri.getPort();
        if (port == 443 && "https".equals(scheme)) port = -1;
        return scheme + "://" + host + (port > 0 ? ":" + port : "");
    }
}
