package com.kittycorp.sidechat;

import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/** Native app lock and server-authorized screenshot exception. Fail closed. */
final class SecretChatSecurity {
    private final MainActivity activity;
    private final SharedPreferences preferences;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final AtomicInteger sessionGeneration = new AtomicInteger();
    private LinearLayout cover;
    private BiometricPrompt prompt;
    private boolean authenticating;
    private volatile boolean locked;
    private volatile long adminUntil;
    private String sessionToken;
    private Runnable authenticationSuccess;
    private Runnable authenticationFailure;

    SecretChatSecurity(MainActivity activity) {
        this.activity = activity;
        preferences = activity.getSharedPreferences("secretchat_security", 0);
        locked = enabled();
        cover = new LinearLayout(activity);
        cover.setOrientation(LinearLayout.VERTICAL);
        cover.setGravity(Gravity.CENTER);
        cover.setBackgroundColor(Color.rgb(8, 13, 15));
        cover.setPadding(40, 40, 40, 40);
        TextView title = new TextView(activity);
        title.setText("SecretChat is locked"); title.setTextColor(Color.WHITE); title.setTextSize(24);
        TextView detail = new TextView(activity);
        detail.setText("Use your enrolled fingerprint or strong biometric to unlock.");
        detail.setTextColor(Color.LTGRAY); detail.setGravity(Gravity.CENTER); detail.setPadding(0, 24, 0, 24);
        Button unlock = new Button(activity); unlock.setText("Unlock SecretChat");
        unlock.setOnClickListener(v -> authenticate(null, null));
        Button pin = new Button(activity); pin.setText("Use device PIN / password");
        pin.setOnClickListener(v -> confirmCredential(null, null));
        cover.addView(title); cover.addView(detail); cover.addView(unlock); cover.addView(pin);
        activity.addContentView(cover, new android.view.ViewGroup.LayoutParams(-1, -1));
        cover.setVisibility(locked ? View.VISIBLE : View.GONE);
        prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), new BiometricPrompt.AuthenticationCallback() {
            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                completeAuthentication();
            }
            @Override public void onAuthenticationError(int code, CharSequence message) {
                authenticating = false;
                Runnable failure = authenticationFailure; authenticationSuccess = null; authenticationFailure = null;
                if (failure != null) failure.run();
                // A cancelled prompt leaves the cover in place. Nothing is unlocked.
            }
        });
    }
    boolean enabled() { return preferences.getBoolean("biometric", false); }
    boolean available() { return BiometricManager.from(activity).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS; }
    boolean isLocked() { return locked; }
    void setEnabled(boolean enabled, Runnable success, Runnable failure) {
        if (enabled && !available()) { failure.run(); return; }
        authenticate(() -> { preferences.edit().putBoolean("biometric", enabled).apply(); success.run(); }, failure);
    }
    void authenticate(Runnable success, Runnable failure) {
        if (authenticating) { if (failure != null) failure.run(); return; }
        if (!available()) { confirmCredential(success, failure); return; }
        authenticationSuccess = success; authenticationFailure = failure; authenticating = true;
        prompt.authenticate(new BiometricPrompt.PromptInfo.Builder().setTitle("Unlock SecretChat")
            .setSubtitle("Confirm your fingerprint or strong biometric")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText("Cancel").build());
    }
    private void completeAuthentication() {
        authenticating = false; locked = false; cover.setVisibility(View.GONE); applyCapturePolicy();
        Runnable success = authenticationSuccess; authenticationSuccess = null; authenticationFailure = null;
        if (success != null) success.run();
        activity.notifyUnlocked();
    }
    private void confirmCredential(Runnable success, Runnable failure) {
        if (authenticating) { if (failure != null) failure.run(); return; }
        android.app.KeyguardManager manager = activity.getSystemService(android.app.KeyguardManager.class);
        android.content.Intent intent = manager.createConfirmDeviceCredentialIntent("Unlock SecretChat", "Confirm your device PIN or password");
        if (intent == null) { if (failure != null) failure.run(); return; }
        authenticationSuccess = success; authenticationFailure = failure; authenticating = true;
        activity.startActivityForResult(intent, 2036);
    }
    void credentialResult(int resultCode) {
        if (resultCode == android.app.Activity.RESULT_OK) completeAuthentication();
        else { authenticating = false; Runnable failure = authenticationFailure; authenticationSuccess = null; authenticationFailure = null; if (failure != null) failure.run(); }
    }
    void onResume() {
        if (locked) { cover.setVisibility(View.VISIBLE); authenticate(null, null); }
        applyCapturePolicy();
        if (sessionToken != null) verifySession(sessionToken);
    }
    void onPause() {
        protectCapture();
        if (enabled()) { locked = true; cover.setVisibility(View.VISIBLE); }
    }
    void protectCapture() { activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE); }
    private void applyCapturePolicy() {
        if (!locked && adminUntil > System.currentTimeMillis() && activity.isForeground())
            activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else protectCapture();
    }
    void verifySession(String token) {
        sessionToken = token;
        int generation = sessionGeneration.incrementAndGet();
        adminUntil = 0; protectCapture();
        if (token == null || token.isBlank() || token.length() > 10000) return;
        worker.execute(() -> {
            boolean admin = false;
            long expiry = 0;
            try {
                URL url = new URL(BuildConfig.SUPABASE_URL + "/rest/v1/rpc/mobile_profile");
                if (!url.getProtocol().equals("https") || url.getUserInfo() != null) return;
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Authorization", "Bearer " + token);
                connection.setRequestProperty("apikey", BuildConfig.SUPABASE_PUBLISHABLE_KEY);
                connection.setRequestProperty("Content-Type", "application/json");
                byte[] body = "{\"p_display_name\":null}".getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (var out = connection.getOutputStream()) { out.write(body); }
                if (connection.getResponseCode() == 200) {
                    byte[] response;
                    try (var input = connection.getInputStream()) { response = input.readNBytes(16001); }
                    if (response.length <= 16000) {
                        admin = new JSONObject(new String(response, StandardCharsets.UTF_8)).optBoolean("is_admin", false);
                        // This expiry is used only after the server accepts the signed token.
                        byte[] claims = android.util.Base64.decode(token.split("\\.")[1], android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP);
                        expiry = Math.min(System.currentTimeMillis() + 300000, new JSONObject(new String(claims, StandardCharsets.UTF_8)).optLong("exp", 0) * 1000);
                    }
                }
                connection.disconnect();
            } catch (Exception ignored) { /* Offline, expired and invalid sessions retain protection. */ }
            final boolean permitted = admin;
            final long validUntil = expiry;
            handler.post(() -> {
                if (generation != sessionGeneration.get()) return;
                adminUntil = permitted ? validUntil : 0;
                applyCapturePolicy();
                if (permitted) handler.postDelayed(() -> { if (generation == sessionGeneration.get()) { adminUntil = 0; applyCapturePolicy(); } }, Math.max(0, validUntil-System.currentTimeMillis()));
                // Refresh the server decision while the same account stays foreground.
                // A revoked or offline session loses the exception on the next check.
                if (permitted && validUntil > System.currentTimeMillis() + 60000)
                    handler.postDelayed(() -> { if (generation == sessionGeneration.get() && activity.isForeground() && !locked) verifySession(token); }, Math.min(240000, validUntil-System.currentTimeMillis()-30000));
            });
        });
    }
    void destroy() { sessionGeneration.incrementAndGet(); worker.shutdownNow(); handler.removeCallbacksAndMessages(null); }
}
