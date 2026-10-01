package com.kittycorp.sidechat;

import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Set;

/** Pure validation kept separate from Android UI and download side effects. */
final class UpdatePolicy {
    static URL downloadUrl(String value, String sha256, Integer version) throws Exception {
        if (sha256 == null || !sha256.matches("[a-f0-9]{64}") || version == null || version <= 0) {
            throw new IllegalArgumentException("The update information is invalid.");
        }
        URL url = new URL(value);
        if (!"https".equals(url.getProtocol()) || url.getHost().isEmpty() || url.getUserInfo() != null || (url.getPort() != -1 && url.getPort() != 443)) {
            throw new IllegalArgumentException("The update must use a direct HTTPS download.");
        }
        return url;
    }

    static void requireHash(String actual, String expected) {
        if (!MessageDigest.isEqual(actual.getBytes(StandardCharsets.US_ASCII), expected.getBytes(StandardCharsets.US_ASCII))) {
            throw new SecurityException("Update checksum did not match.");
        }
    }

    static void requireIdentity(String actualPackage, String installedPackage, long actualVersion, long requestedVersion,
                                long installedVersion, Set<String> installedSigners, Set<String> candidateSigners) {
        if (!installedPackage.equals(actualPackage)) throw new SecurityException("This update is not a SecretChat package.");
        if (actualVersion != requestedVersion || actualVersion <= installedVersion) throw new SecurityException("The APK version does not match its release information or is not newer.");
        if (installedSigners == null || installedSigners.isEmpty() || !installedSigners.equals(candidateSigners)) {
            throw new SecurityException("The update was not signed with the SecretChat release key.");
        }
    }
}
