package com.kittycorp.sidechat;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    SecretChatSecurity security;
    private boolean foreground;
    boolean isForeground() { return foreground; }
    void notifyUnlocked() {
        if (getBridge() != null) {
            var handle = getBridge().getPlugin("SideChatDevice");
            if (handle != null) ((SideChatDevicePlugin) handle.getInstance()).unlocked();
        }
    }
    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        registerPlugin(SideChatDevicePlugin.class);
        super.onCreate(savedInstanceState);
        security = new SecretChatSecurity(this);
        if (getBridge() != null) getBridge().getWebView().setBackgroundColor(0xFF070D12);
        android.webkit.WebView.setWebContentsDebuggingEnabled(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel("secretchat_room_v15", "Room activity", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("SecretChat room arrival alerts");
            channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[] { 0, 55, 70, 55 });
            Uri sound = Uri.parse("android.resource://" + getPackageName() + "/raw/secretchat_ping_v15");
            channel.setSound(sound, new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }
    @Override public void onResume() { super.onResume(); foreground = true; if (security != null) security.onResume(); }
    @Override public void onPause() { foreground = false; if (security != null) security.onPause(); super.onPause(); }
    @Override public void onDestroy() { if (security != null) security.destroy(); super.onDestroy(); }
    @Override protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == 2036 && security != null) security.credentialResult(resultCode);
    }
}
