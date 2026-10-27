package com.magicalmiku39.leasedline;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.URLUtil;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Saves exported files into the phone's Download/专线台账 folder. */
final class Downloads {
    static final String XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    private static final String FOLDER = "专线台账";
    private static final Pattern FILENAME_STAR = Pattern.compile("filename\\*\\s*=\\s*(?:UTF-8|utf-8)''([^;]+)");
    private static final Pattern FILENAME = Pattern.compile("filename\\s*=\\s*\"?([^\";]+)\"?");

    private Downloads() {
    }

    /** Where a file ended up: a content Uri that can be opened (Android 10+), and a readable place. */
    static final class Saved {
        final Uri uri;
        final String place;

        Saved(Uri uri, String place) {
            this.uri = uri;
            this.place = place;
        }
    }

    static String fileName(String contentDisposition, String url, String mimeType) {
        String name = null;
        if (contentDisposition != null) {
            Matcher star = FILENAME_STAR.matcher(contentDisposition);
            Matcher plain = FILENAME.matcher(contentDisposition);
            try {
                if (star.find()) name = URLDecoder.decode(star.group(1).trim(), "UTF-8");
                else if (plain.find()) name = plain.group(1).trim();
            } catch (Exception ignored) {
                name = null;
            }
        }
        if (name == null || name.isEmpty()) name = URLUtil.guessFileName(url, contentDisposition, mimeType);
        return clean(name, mimeType);
    }

    static String clean(String name, String mimeType) {
        String safe = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (safe.isEmpty()) safe = "导出文件";
        if (!safe.contains(".") && XLSX.equals(mimeType)) safe += ".xlsx";
        return safe;
    }

    static Saved save(Context context, String name, String mimeType, InputStream input) throws IOException {
        String type = mimeType == null || mimeType.isEmpty() ? guessType(name) : mimeType;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, type);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("无法在“下载”中创建文件");
            try (OutputStream output = resolver.openOutputStream(uri)) {
                if (output == null) throw new IOException("无法写入文件");
                copy(input, output);
            } catch (IOException e) {
                resolver.delete(uri, null, null);
                throw e;
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
            return new Saved(uri, "下载/" + FOLDER + "/" + name);
        }
        // Android 7–9: the app's own download folder needs no storage permission.
        File dir = new File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), FOLDER);
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建下载目录");
        File file = new File(dir, name);
        try (OutputStream output = new FileOutputStream(file)) {
            copy(input, output);
        }
        return new Saved(null, file.getAbsolutePath());
    }

    private static String guessType(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".xlsx")) return XLSX;
        if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
        return "application/octet-stream";
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
    }
}
