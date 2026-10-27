package com.magicalmiku39.leasedline;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.security.cert.X509Certificate;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

/**
 * Remote client for the ledger system: the server's web interface in a WebView, HTTPS only.
 * A self-signed server certificate is accepted only when its SHA-256 fingerprint matches the
 * one the user confirmed on first connection; plain http and other origins never load here.
 */
public class MainActivity extends Activity {
    private static final int REQUEST_FILE = 41;
    private static final int MAX_BLOB_BYTES = 60 * 1024 * 1024;

    /** Front-end exports (SheetJS) save through a blob link; hand those bytes to the app instead. */
    private static final String DOWNLOAD_HOOK = "(function(){"
            + "if(window.__ledgerAppHooked)return;window.__ledgerAppHooked=true;"
            + "function send(name,href){fetch(href).then(function(r){return r.blob();}).then(function(b){"
            + "var reader=new FileReader();reader.onload=function(){var s=String(reader.result);"
            + "LedgerApp.saveBase64(name||'',b.type||'',s.substring(s.indexOf(',')+1));};reader.readAsDataURL(b);"
            + "}).catch(function(e){LedgerApp.saveFailed(String(e));});}"
            + "var click=HTMLAnchorElement.prototype.click;"
            + "HTMLAnchorElement.prototype.click=function(){"
            + "if(this.href&&this.href.indexOf('blob:')===0){send(this.getAttribute('download'),this.href);return;}"
            + "return click.apply(this,arguments);};"
            + "document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href^=\"blob:\"]'):null;"
            + "if(a){e.preventDefault();send(a.getAttribute('download'),a.href);}},true);"
            + "})();";

    private final Handler mainThread = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private ServerConfig config;
    private FrameLayout root;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private volatile String pageOrigin;
    private boolean sslDialogShowing;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CrashLog.install(this);
        config = new ServerConfig(this);
        root = new FrameLayout(this);
        root.setBackgroundColor(0xFFF5F5F7);
        drawEdgeToEdge();
        setContentView(root);
        String crash = CrashLog.pending(this);
        if (crash != null) showCrashReport(crash);
        else showStart();
    }

    private void showStart() {
        if (config.isReady()) showWeb();
        else showSetup(config.url(), null);
    }

    /** Shown once after a crash, before anything that might crash again, so the trace can be copied. */
    private void showCrashReport(String report) {
        root.removeAllViews();
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(24), dp(40), dp(24), dp(24));

        TextView title = new TextView(this);
        title.setText("上次运行异常退出");
        title.setTextColor(0xFF111114);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        column.addView(title);

        TextView hint = new TextView(this);
        hint.setText("请点“复制”，把下面的内容发给开发者排查。内容只包含错误信息和手机型号，不含账号或业务数据。");
        hint.setTextColor(0xFF6E6E73);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        hint.setPadding(0, dp(8), 0, dp(12));
        column.addView(hint);

        TextView detail = new TextView(this);
        detail.setText(report);
        detail.setTextIsSelectable(true);
        detail.setTextColor(0xFF3A3A3C);
        detail.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        detail.setTypeface(Typeface.MONOSPACE);
        column.addView(detail);

        Button copy = new Button(this);
        copy.setText("复制");
        copy.setOnClickListener(v -> {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("崩溃信息", report));
            toast("已复制");
        });
        column.addView(copy);

        Button proceed = new Button(this);
        proceed.setText("继续");
        proceed.setOnClickListener(v -> {
            CrashLog.clear(this);
            showStart();
        });
        column.addView(proceed);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(column);
        root.addView(scroll);
    }

    // ---------- window ----------

    /** Draw under the system bars and pad the content by their size (and the keyboard's). */
    private void drawEdgeToEdge() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(light, light);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            }
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    // ---------- first connection ----------

    private void showSetup(String presetUrl, String error) {
        destroyWebView();
        root.removeAllViews();

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(24), dp(40), dp(24), dp(24));

        TextView title = new TextView(this);
        title.setText("专线台账");
        title.setTextColor(0xFF111114);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        column.addView(title);

        TextView hint = new TextView(this);
        hint.setText("输入服务器的 HTTPS 地址，域名或 IP 均可，例如 https://ledger.example.com 或 https://192.168.1.20:3443。不写端口时默认 443。首次连接需要核对服务器证书指纹。");
        hint.setTextColor(0xFF6E6E73);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        hint.setPadding(0, dp(8), 0, dp(20));
        column.addView(hint);

        TextView label = new TextView(this);
        label.setText("服务器地址");
        label.setTextColor(0xFF3A3A3C);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        column.addView(label);

        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setHint("https://域名或IP:端口");
        if (presetUrl != null) address.setText(presetUrl);
        column.addView(address, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView message = new TextView(this);
        message.setTextColor(0xFFB42318);
        message.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        message.setPadding(0, dp(8), 0, dp(8));
        if (error != null) message.setText(error);
        column.addView(message);

        Button connect = new Button(this);
        connect.setText("连接");
        column.addView(connect, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Runnable attempt = () -> {
            String url;
            try {
                url = ServerConfig.normalize(address.getText().toString());
            } catch (IllegalArgumentException e) {
                message.setText(e.getMessage());
                return;
            }
            message.setText("");
            connect.setEnabled(false);
            connect.setText("正在连接…");
            probeAndConfirm(url, failure -> {
                connect.setEnabled(true);
                connect.setText("连接");
                message.setText(failure);
            });
        };
        connect.setOnClickListener(v -> attempt.run());
        address.setOnEditorActionListener((v, actionId, event) -> {
            attempt.run();
            return true;
        });

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(column);
        root.addView(scroll);
    }

    private interface Failure {
        void show(String text);
    }

    /** Reads the server certificate and asks the user to confirm its fingerprint. */
    private void probeAndConfirm(String url, Failure onFailure) {
        io.execute(() -> {
            try {
                CertUtil.Probe probe = CertUtil.probe(url);
                mainThread.post(() -> confirmCertificate(url, probe, onFailure));
            } catch (IOException e) {
                String reason = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                mainThread.post(() -> onFailure.show("无法连接：" + reason + "\n请确认地址、端口和网络，以及服务器已启动。"));
            }
        });
    }

    private void confirmCertificate(String url, CertUtil.Probe probe, Failure onFailure) {
        if (isFinishing()) return;
        if (probe.systemTrusted) {
            config.save(url, ServerConfig.SYSTEM_TRUST);
            showWeb();
            return;
        }
        String fingerprint = CertUtil.fingerprint(probe.certificate);
        new AlertDialog.Builder(this)
                .setTitle("确认服务器证书")
                .setMessage(url + " 使用的是自签名证书。\n\n" + CertUtil.describe(probe.certificate)
                        + "\n\nSHA-256 指纹：\n" + fingerprint
                        + "\n\n请与管理员提供的指纹逐位核对，完全一致才信任。以后只接受这一张证书。")
                .setCancelable(false)
                .setPositiveButton("信任并连接", (dialog, which) -> {
                    config.save(url, fingerprint);
                    showWeb();
                })
                .setNegativeButton("取消", (dialog, which) -> onFailure.show("未信任该证书，没有连接。"))
                .show();
    }

    // ---------- web view ----------

    private void showWeb() {
        destroyWebView();
        root.removeAllViews();
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setUserAgentString(settings.getUserAgentString() + " LeasedLineClient/Android");

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        webView.addJavascriptInterface(new Bridge(), "LedgerApp");
        webView.setWebViewClient(new LedgerWebViewClient());
        webView.setWebChromeClient(new LedgerChromeClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                onDownload(url, userAgent, contentDisposition, mimeType));
        webView.loadUrl(config.url() + "/");
    }

    private void destroyWebView() {
        if (webView == null) return;
        root.removeView(webView);
        webView.stopLoading();
        webView.destroy();
        webView = null;
        pageOrigin = null;
    }

    private boolean isServerOrigin(String url) {
        String allowed = config.origin();
        return url != null && allowed != null && allowed.equals(ServerConfig.originOf(url));
    }

    private final class LedgerWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isServerOrigin(uri.toString())) return false;
            String scheme = uri.getScheme() == null ? "" : uri.getScheme();
            if ("https".equals(scheme) || "mailto".equals(scheme) || "tel".equals(scheme)) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    toast("没有可以打开该链接的应用");
                }
            } else {
                toast("已拦截非 HTTPS 链接");
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            pageOrigin = isServerOrigin(url) ? config.origin() : null;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (isServerOrigin(url)) view.evaluateJavascript(DOWNLOAD_HOOK, null);
            CookieManager.getInstance().flush();
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            X509Certificate certificate = CertUtil.fromSslCertificate(error.getCertificate());
            if (isServerOrigin(error.getUrl()) && CertUtil.matchesPin(certificate, config.pin())) {
                handler.proceed();
                return;
            }
            handler.cancel();
            if (isServerOrigin(error.getUrl())) showCertificateChanged(certificate);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            // A navigation that turns into a file download (the ledger export) can report an
            // aborted load; only a failed page load replaces the screen with the error view.
            String path = request.getUrl().getPath();
            boolean apiRequest = path != null && path.contains("/api/");
            if (request.isForMainFrame() && !apiRequest) showConnectionError(String.valueOf(error.getDescription()));
        }
    }

    private final class LedgerChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                    Downloads.XLSX, "application/vnd.ms-excel", "application/octet-stream"});
            try {
                startActivityForResult(intent, REQUEST_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                toast("没有可以选择文件的应用");
                return false;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    // ---------- certificate and connection problems ----------

    private void showCertificateChanged(X509Certificate certificate) {
        if (sslDialogShowing || isFinishing()) return;
        sslDialogShowing = true;
        String detail = certificate == null ? "无法读取新证书。"
                : CertUtil.describe(certificate) + "\nSHA-256 指纹：\n" + CertUtil.fingerprint(certificate);
        new AlertDialog.Builder(this)
                .setTitle("服务器证书与已确认的不一致")
                .setMessage("可能是服务器更换了证书，也可能是网络被拦截。未确认前不会连接。\n\n" + detail)
                .setCancelable(false)
                .setPositiveButton("重新确认证书", (dialog, which) -> {
                    sslDialogShowing = false;
                    String url = config.url();
                    config.forgetPin();
                    showSetup(url, null);
                    probeAndConfirm(url, failure -> showSetup(url, failure));
                })
                .setNeutralButton("更换服务器", (dialog, which) -> {
                    sslDialogShowing = false;
                    showSetup(config.url(), null);
                })
                .setNegativeButton("关闭", (dialog, which) -> sslDialogShowing = false)
                .show();
    }

    private void showConnectionError(String description) {
        destroyWebView();
        root.removeAllViews();
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);
        column.setPadding(dp(24), dp(24), dp(24), dp(24));

        TextView title = new TextView(this);
        title.setText("无法连接服务器");
        title.setTextColor(0xFF111114);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        column.addView(title);

        TextView detail = new TextView(this);
        detail.setText(config.url() + "\n" + description + "\n\n请确认手机网络能访问服务器，且服务器已启动。");
        detail.setTextColor(0xFF6E6E73);
        detail.setGravity(Gravity.CENTER);
        detail.setPadding(0, dp(10), 0, dp(20));
        column.addView(detail);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(v -> showWeb());
        column.addView(retry);

        Button change = new Button(this);
        change.setText("更换服务器");
        change.setOnClickListener(v -> showSetup(config.url(), null));
        column.addView(change);

        root.addView(column, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    // ---------- downloads ----------

    private void onDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        if (url.startsWith("blob:")) {
            webView.evaluateJavascript("fetch(" + jsString(url) + ").then(function(r){return r.blob();}).then(function(b){"
                    + "var f=new FileReader();f.onload=function(){var s=String(f.result);"
                    + "LedgerApp.saveBase64('',b.type||'',s.substring(s.indexOf(',')+1));};f.readAsDataURL(b);});", null);
            return;
        }
        if (!isServerOrigin(url)) {
            toast("已拦截来自其他地址的下载");
            return;
        }
        String pin = config.pin();
        toast("正在下载…");
        io.execute(() -> {
            HttpsURLConnection connection = null;
            try {
                connection = (HttpsURLConnection) new URL(url).openConnection();
                connection.setSSLSocketFactory(CertUtil.pinnedSocketFactory(pin));
                connection.setHostnameVerifier(CertUtil.pinnedHostnameVerifier(pin));
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) connection.setRequestProperty("Cookie", cookie);
                connection.setRequestProperty("User-Agent", userAgent);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(60000);
                int status = connection.getResponseCode();
                if (status != 200) throw new IOException("服务器返回 " + status);
                String type = connection.getContentType() != null ? connection.getContentType() : mimeType;
                String disposition = connection.getHeaderField("Content-Disposition");
                String name = Downloads.fileName(disposition != null ? disposition : contentDisposition, url, type);
                try (InputStream input = connection.getInputStream()) {
                    Downloads.Saved saved = Downloads.save(this, name, type, input);
                    mainThread.post(() -> showSaved(name, saved));
                }
            } catch (Exception e) {
                String reason = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                mainThread.post(() -> toast("下载失败：" + reason));
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void saveBlob(String name, String mimeType, String base64) {
        if (pageOrigin == null) return;
        io.execute(() -> {
            try {
                if (base64 == null || base64.length() > MAX_BLOB_BYTES / 3 * 4 + 4) throw new IOException("文件过大");
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String type = mimeType == null || mimeType.isEmpty() ? Downloads.XLSX : mimeType;
                String fileName = Downloads.clean(name, type);
                Downloads.Saved saved = Downloads.save(this, fileName, type, new ByteArrayInputStream(bytes));
                mainThread.post(() -> showSaved(fileName, saved));
            } catch (Exception e) {
                String reason = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                mainThread.post(() -> toast("保存失败：" + reason));
            }
        });
    }

    private void showSaved(String name, Downloads.Saved saved) {
        if (isFinishing()) return;
        AlertDialog.Builder dialog = new AlertDialog.Builder(this)
                .setTitle("已保存")
                .setMessage(name + "\n位置：" + saved.place)
                .setNegativeButton("好", null);
        if (saved.uri != null) {
            dialog.setPositiveButton("打开", (d, which) -> {
                Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(saved.uri, getContentResolver().getType(saved.uri));
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivity(view);
                } catch (ActivityNotFoundException e) {
                    toast("没有可以打开该文件的应用，请在“文件管理 > 下载 > 专线台账”中查看");
                }
            });
        }
        dialog.show();
    }

    private static String jsString(String value) {
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }

    /** Exposed to the server's own pages only; calls from any other page are ignored. */
    private final class Bridge {
        @JavascriptInterface
        public void saveBase64(String name, String mimeType, String base64) {
            saveBlob(name, mimeType, base64);
        }

        @JavascriptInterface
        public void saveFailed(String reason) {
            mainThread.post(() -> toast("导出失败：" + reason));
        }
    }

    // ---------- lifecycle ----------

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        String[] actions = config.isReady()
                ? new String[]{"退出 App", "更换服务器", "重新确认证书"}
                : new String[]{"退出 App"};
        new AlertDialog.Builder(this)
                .setItems(actions, (dialog, which) -> {
                    if (which == 0) {
                        finish();
                    } else if (which == 1) {
                        showSetup(config.url(), null);
                    } else {
                        String url = config.url();
                        config.forgetPin();
                        showSetup(url, null);
                        probeAndConfirm(url, failure -> showSetup(url, failure));
                    }
                })
                .show();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        destroyWebView();
        io.shutdownNow();
        super.onDestroy();
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_LONG).show();
    }
}
