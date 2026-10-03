package com.kittycorp.sidechat;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Device-bound encrypted storage and signed, explicitly confirmed APK updates. */
@CapacitorPlugin(name = "SideChatDevice")
public class SideChatDevicePlugin extends Plugin {
    private static final String KEY_ALIAS = "com.kittycorp.sidechat.vault.v1";
    private static final int MAX_VALUE_BYTES = 4 * 1024 * 1024;
    private static final long MAX_VAULT_BYTES = 64L * 1024 * 1024;
    private static final long MAX_APK_BYTES = 128L * 1024 * 1024;
    private final ExecutorService storageWorker = Executors.newSingleThreadExecutor();
    private final ExecutorService updateWorker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean updating = new AtomicBoolean(false);
    private SecretChatSecurity security() { return ((MainActivity) getActivity()).security; }
    void unlocked() { notifyListeners("deviceUnlocked", new JSObject()); }
    @PluginMethod
    public void getBiometricStatus(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            result.put("enabled", security().enabled()); result.put("available", security().available()); result.put("locked", security().isLocked());
            call.resolve(result);
        });
    }
    @PluginMethod
    public void setBiometricLock(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) { call.reject("Choose whether to enable fingerprint lock."); return; }
        getActivity().runOnUiThread(() -> security().setEnabled(enabled,
            () -> { JSObject result = new JSObject(); result.put("enabled", enabled); result.put("available", true); call.resolve(result); },
            () -> call.reject("Fingerprint confirmation was cancelled or unavailable. Enrol a strong biometric in Android Settings.")));
    }
    @PluginMethod
    public void setScreenshotSession(PluginCall call) {
        String token = call.getString("accessToken");
        getActivity().runOnUiThread(() -> { security().verifySession(token); call.resolve(); });
    }

    @Override
    protected void handleOnDestroy() {
        storageWorker.shutdown();
        updateWorker.shutdown();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("version", info.versionName);
            result.put("versionCode", versionCode(info));
            call.resolve(result);
        } catch (Exception error) { call.reject("Unable to read app version.", error); }
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        int id = getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName());
        JSObject result = new JSObject();
        result.put("pushConfigured", id != 0 && !getContext().getString(id).isEmpty());
        result.put("screenProtection", true);
        call.resolve(result);
    }

    @PluginMethod
    public void shareExport(PluginCall call) {
        String text = call.getString("text"), filename = call.getString("filename");
        if (text == null || text.getBytes(StandardCharsets.UTF_8).length > 8 * 1024 * 1024 || filename == null || !filename.matches("SecretChat-research-[a-f0-9-]{36}\\.csv")) {
            call.reject("Invalid chat export."); return;
        }
        storageWorker.execute(() -> {
            try {
                if (security().isLocked()) { call.reject("Unlock SecretChat before exporting."); return; }
                File folder = new File(getContext().getCacheDir(), "chat-exports");
                if (!folder.exists() && !folder.mkdirs()) throw new IllegalStateException();
                File[] previous = folder.listFiles();
                if (previous != null) for (File item : previous) if (item.isFile()) item.delete();
                File file = new File(folder, filename);
                try (FileOutputStream output = new FileOutputStream(file)) { output.write(text.getBytes(StandardCharsets.UTF_8)); }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
                getActivity().runOnUiThread(() -> {
                    if (security().isLocked()) { file.delete(); call.reject("Unlock SecretChat before exporting."); return; }
                    try {
                        Intent intent = new Intent(Intent.ACTION_SEND);
                        intent.setType("text/csv"); intent.putExtra(Intent.EXTRA_STREAM, uri);
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        getActivity().startActivity(Intent.createChooser(intent, "Save research chat export"));
                        call.resolve();
                    } catch (Exception error) { file.delete(); call.reject("No export app is available."); }
                });
            } catch (Exception error) { call.reject("Chat export could not be prepared."); }
        });
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        storageWorker.execute(() -> {
            try {
                if (security().isLocked()) { call.reject("Unlock SecretChat before accessing local data.", "APP_LOCKED"); return; }
                String key = checkedKey(call);
                AtomicFile record = recordFor(key);
                JSObject result = new JSObject();
                if (!record.getBaseFile().exists() && !new File(record.getBaseFile().getPath() + ".bak").exists()) { result.put("value", JSONObject.NULL); call.resolve(result); return; }
                if (record.getBaseFile().length() > MAX_VALUE_BYTES + 64) { throw new IllegalArgumentException("Stored record is too large."); }
                byte[] encoded = record.readFully();
                if (encoded.length < 29 || encoded[0] != 1) { throw new IllegalArgumentException("Invalid encrypted record."); }
                byte[] iv = Arrays.copyOfRange(encoded, 1, 13);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, vaultKey(), new GCMParameterSpec(128, iv));
                cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
                byte[] clear = cipher.doFinal(encoded, 13, encoded.length - 13);
                result.put("value", new String(clear, StandardCharsets.UTF_8));
                Arrays.fill(clear, (byte) 0);
                call.resolve(result);
            } catch (Exception error) { call.reject("Could not unlock local data. Do not reinstall if you need to preserve it.", "STORAGE_READ_FAILED", error); }
        });
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        storageWorker.execute(() -> {
            FileOutputStream output = null;
            AtomicFile record = null;
            try {
                String key = checkedKey(call);
                String value = call.getString("value");
                if (value == null) { throw new IllegalArgumentException("value is required."); }
                byte[] clear = value.getBytes(StandardCharsets.UTF_8);
                if (clear.length > MAX_VALUE_BYTES) { throw new IllegalArgumentException("Local record exceeds 4 MB."); }
                record = recordFor(key);
                File[] records = record.getBaseFile().getParentFile().listFiles();
                long bytes = 0;
                if (records != null) { for (File item : records) { if (!item.equals(record.getBaseFile())) bytes += item.length(); } }
                if (bytes + clear.length + 29 > MAX_VAULT_BYTES) { throw new IllegalArgumentException("Local storage limit reached. Clear older rooms in Settings."); }
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, vaultKey());
                cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
                byte[] encrypted = cipher.doFinal(clear);
                Arrays.fill(clear, (byte) 0);
                byte[] encoded = ByteBuffer.allocate(1 + cipher.getIV().length + encrypted.length).put((byte) 1).put(cipher.getIV()).put(encrypted).array();
                output = record.startWrite();
                output.write(encoded);
                record.finishWrite(output);
                output = null;
                call.resolve();
            } catch (Exception error) {
                if (record != null && output != null) record.failWrite(output);
                call.reject("Could not save encrypted local data.", "STORAGE_WRITE_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        storageWorker.execute(() -> {
            try { recordFor(checkedKey(call)).delete(); call.resolve(); }
            catch (Exception error) { call.reject("Could not remove local data.", error); }
        });
    }

    private String checkedKey(PluginCall call) {
        String key = call.getString("key");
        if (key == null || !key.matches("[A-Za-z0-9_.:-]{1,160}")) { throw new IllegalArgumentException("Invalid storage key."); }
        return key;
    }

    private AtomicFile recordFor(String key) throws Exception {
        File folder = new File(getContext().getNoBackupFilesDir(), "sidechat-vault");
        if (!folder.exists() && !folder.mkdirs()) throw new IllegalStateException("Private storage unavailable.");
        return new AtomicFile(new File(folder, hex(MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8))) + ".bin"));
    }

    private SecretKey vaultKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(KEY_ALIAS, null);
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        final String urlText = call.getString("url", "");
        final String sha256 = call.getString("sha256", "").toLowerCase(java.util.Locale.ROOT);
        final Integer requestedVersion = call.getInt("versionCode");
        final URL url;
        try {
            url = UpdatePolicy.downloadUrl(urlText, sha256, requestedVersion);
        } catch (Exception error) { call.reject("The update information must include a direct HTTPS URL, valid checksum, and version."); return; }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            getActivity().runOnUiThread(() -> {
                try {
                    Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                    getActivity().startActivity(settings);
                    JSObject result = new JSObject();
                    result.put("status", "permission_required");
                    result.put("message", "Allow SecretChat to install updates, return to SecretChat, then tap Update again. Android will ask you to confirm installation.");
                    call.resolve(result);
                } catch (Exception error) { call.reject("Open Android Settings and allow SecretChat to install updates, then try again.", error); }
            });
            return;
        }
        if (!updating.compareAndSet(false, true)) { call.reject("An update is already being downloaded."); return; }
        updateWorker.execute(() -> {
            HttpURLConnection connection = null;
            File downloaded = null;
            try {
                PackageManager manager = getContext().getPackageManager();
                int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
                PackageInfo installed = manager.getPackageInfo(getContext().getPackageName(), flags);
                if (requestedVersion <= versionCode(installed)) throw new IllegalArgumentException("This version is already installed.");
                File folder = new File(getContext().getCacheDir(), "verified-updates");
                if (!folder.exists() && !folder.mkdirs()) throw new IllegalStateException("Update storage unavailable.");
                downloaded = new File(folder, "sidechat-" + requestedVersion + "-" + sha256 + ".apk");
                connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(30000);
                connection.setRequestProperty("Accept", "application/vnd.android.package-archive, application/octet-stream");
                connection.setRequestProperty("Accept-Encoding", "identity");
                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) throw new IllegalArgumentException("The update link must return the APK directly without redirects.");
                if (connection.getContentLengthLong() > MAX_APK_BYTES) throw new IllegalArgumentException("The update is too large.");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long total = 0;
                long deadline = android.os.SystemClock.elapsedRealtime() + 180000;
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(downloaded)) {
                    byte[] buffer = new byte[32768];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        total += read;
                        if (total > MAX_APK_BYTES || android.os.SystemClock.elapsedRealtime() > deadline) throw new IllegalArgumentException("Update download exceeded its limit. Try a faster connection.");
                        digest.update(buffer, 0, read);
                        output.write(buffer, 0, read);
                    }
                    output.getFD().sync();
                }
                UpdatePolicy.requireHash(hex(digest.digest()), sha256);
                PackageInfo candidate = manager.getPackageArchiveInfo(downloaded.getAbsolutePath(), flags);
                if (candidate == null) throw new SecurityException("The downloaded file is not a readable Android package.");
                UpdatePolicy.requireIdentity(candidate.packageName, installed.packageName, versionCode(candidate), requestedVersion,
                    versionCode(installed), signers(installed), signers(candidate));
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", downloaded);
                getActivity().runOnUiThread(() -> {
                    try {
                        Intent installer = new Intent(Intent.ACTION_VIEW);
                        installer.setDataAndType(uri, "application/vnd.android.package-archive");
                        installer.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        getActivity().startActivity(installer);
                        JSObject result = new JSObject(); result.put("status", "installer_opened"); call.resolve(result);
                    } catch (Exception error) { call.reject("Android could not open the update installer.", error); }
                    finally { updating.set(false); }
                });
            } catch (Exception error) {
                if (downloaded != null) downloaded.delete();
                updating.set(false);
                call.reject(error.getMessage() == null ? "Unable to verify the update." : error.getMessage(), "UPDATE_FAILED", error);
            } finally { if (connection != null) connection.disconnect(); }
        });
    }

    private long versionCode(PackageInfo info) { return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode; }

    private Set<String> signers(PackageInfo info) throws Exception {
        Signature[] signatures = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null ? info.signingInfo.getApkContentsSigners() : info.signatures;
        Set<String> result = new HashSet<>();
        if (signatures != null) for (Signature signature : signatures) result.add(hex(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())));
        return result;
    }

    private String hex(byte[] value) {
        StringBuilder result = new StringBuilder(value.length * 2);
        for (byte item : value) result.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return result.toString();
    }
}
