package com.magicalmiku39.leasedline;

import android.net.http.SslCertificate;
import android.os.Build;
import android.os.Bundle;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URL;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.Locale;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/** Certificate fingerprints, the first-contact probe and pinned HTTPS connections. */
final class CertUtil {
    private CertUtil() {
    }

    /** What the server presented on first contact. Nothing is trusted yet at this point. */
    static final class Probe {
        final X509Certificate certificate;
        final boolean systemTrusted;

        Probe(X509Certificate certificate, boolean systemTrusted) {
            this.certificate = certificate;
            this.systemTrusted = systemTrusted;
        }
    }

    static String fingerprint(X509Certificate certificate) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < digest.length; i++) {
                if (i > 0) out.append(':');
                out.append(String.format(Locale.ROOT, "%02X", digest[i] & 0xff));
            }
            return out.toString();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    static String describe(X509Certificate certificate) {
        SimpleDateFormat day = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
        return "证书名称：" + certificate.getSubjectX500Principal().getName()
                + "\n有效期：" + day.format(certificate.getNotBefore()) + " 至 " + day.format(certificate.getNotAfter());
    }

    /** The leaf certificate behind a WebView SSL error. */
    static X509Certificate fromSslCertificate(SslCertificate sslCertificate) {
        if (sslCertificate == null) return null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return sslCertificate.getX509Certificate();
        Bundle state = SslCertificate.saveState(sslCertificate);
        byte[] bytes = state == null ? null : state.getByteArray("x509-certificate");
        if (bytes == null) return null;
        try {
            CertificateFactory factory = CertificateFactory.getInstance("X.509");
            return (X509Certificate) factory.generateCertificate(new ByteArrayInputStream(bytes));
        } catch (CertificateException e) {
            return null;
        }
    }

    static boolean matchesPin(X509Certificate certificate, String pin) {
        return certificate != null && pin != null && !ServerConfig.SYSTEM_TRUST.equals(pin)
                && pin.equalsIgnoreCase(fingerprint(certificate));
    }

    private static X509TrustManager systemTrustManager() throws GeneralSecurityException {
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init((KeyStore) null);
        for (TrustManager manager : factory.getTrustManagers()) {
            if (manager instanceof X509TrustManager) return (X509TrustManager) manager;
        }
        throw new GeneralSecurityException("No system trust manager");
    }

    /**
     * Opens one connection to read the certificate the server presents. The connection carries
     * no cookies or credentials; the user decides afterwards whether to trust what was shown.
     */
    static Probe probe(String baseUrl) throws IOException {
        final X509Certificate[] seen = new X509Certificate[1];
        final boolean[] chainTrusted = {false};
        final boolean[] hostnameOk = {false};
        try {
            final X509TrustManager system = systemTrustManager();
            X509TrustManager recording = new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                    throw new CertificateException("Client certificates are not used");
                }

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType) {
                    if (chain != null && chain.length > 0) seen[0] = chain[0];
                    try {
                        system.checkServerTrusted(chain, authType);
                        chainTrusted[0] = true;
                    } catch (CertificateException e) {
                        chainTrusted[0] = false;
                    }
                }

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            };
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[]{recording}, null);
            HttpsURLConnection connection = (HttpsURLConnection) new URL(baseUrl + "/api/auth/status").openConnection();
            connection.setSSLSocketFactory(context.getSocketFactory());
            final HostnameVerifier standard = HttpsURLConnection.getDefaultHostnameVerifier();
            connection.setHostnameVerifier((host, session) -> {
                hostnameOk[0] = standard.verify(host, session);
                return true;
            });
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setUseCaches(false);
            try {
                connection.getResponseCode();
            } finally {
                connection.disconnect();
            }
        } catch (GeneralSecurityException e) {
            throw new IOException("无法建立 HTTPS 连接：" + e.getMessage(), e);
        }
        if (seen[0] == null) throw new IOException("服务器没有提供证书");
        return new Probe(seen[0], chainTrusted[0] && hostnameOk[0]);
    }

    /** Socket factory that accepts certificates Android trusts, or the one pinned certificate. */
    static SSLSocketFactory pinnedSocketFactory(final String pin) throws GeneralSecurityException {
        final X509TrustManager system = systemTrustManager();
        X509TrustManager pinned = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("Client certificates are not used");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                try {
                    system.checkServerTrusted(chain, authType);
                } catch (CertificateException e) {
                    if (chain == null || chain.length == 0 || !matchesPin(chain[0], pin)) {
                        throw new CertificateException("服务器证书与已确认的指纹不一致", e);
                    }
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return system.getAcceptedIssuers();
            }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[]{pinned}, null);
        return context.getSocketFactory();
    }

    /** Standard hostname check, except for the pinned certificate (issued for "localhost"). */
    static HostnameVerifier pinnedHostnameVerifier(final String pin) {
        final HostnameVerifier standard = HttpsURLConnection.getDefaultHostnameVerifier();
        return (String host, SSLSession session) -> {
            if (standard.verify(host, session)) return true;
            try {
                Certificate[] chain = session.getPeerCertificates();
                return chain.length > 0 && chain[0] instanceof X509Certificate
                        && matchesPin((X509Certificate) chain[0], pin);
            } catch (SSLPeerUnverifiedException e) {
                return false;
            }
        };
    }
}
