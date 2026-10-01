package com.kittycorp.sidechat;

import static org.junit.Assert.*;
import java.util.Set;
import org.junit.Test;

public class UpdatePolicyTest {
    private static final String HASH = "a".repeat(64);
    private static final String PACKAGE = "com.kittycorp.sidechat";

    @Test public void acceptsDirectHttpsAndSignedQuery() throws Exception {
        assertEquals("cdn.example.com", UpdatePolicy.downloadUrl("https://cdn.example.com/app.apk?token=test", HASH, 2).getHost());
        assertEquals(443, UpdatePolicy.downloadUrl("https://cdn.example.com:443/app.apk", HASH, 2).getPort());
    }
    @Test public void rejectsCleartextAndLocalFiles() {
        for (String url : new String[] {"http://cdn.example.com/app.apk", "file:///data/app.apk", "https://cdn.example.com:8443/app.apk", "https://user:password@cdn.example.com/app.apk"}) {
            assertThrows(Exception.class, () -> UpdatePolicy.downloadUrl(url, HASH, 2));
        }
    }
    @Test public void requiresExactSha256AndPositiveVersion() {
        assertThrows(Exception.class, () -> UpdatePolicy.downloadUrl("https://example.com/a.apk", "a".repeat(63), 2));
        assertThrows(Exception.class, () -> UpdatePolicy.downloadUrl("https://example.com/a.apk", "g".repeat(64), 2));
        assertThrows(Exception.class, () -> UpdatePolicy.downloadUrl("https://example.com/a.apk", HASH, 0));
        assertThrows(Exception.class, () -> UpdatePolicy.downloadUrl("https://example.com/a.apk", HASH, null));
    }
    @Test public void modifiedDownloadIsRejected() {
        UpdatePolicy.requireHash(HASH, HASH);
        assertThrows(SecurityException.class, () -> UpdatePolicy.requireHash("b" + HASH.substring(1), HASH));
    }
    @Test public void acceptsOnlyNewerCorrectlySignedPackage() {
        UpdatePolicy.requireIdentity(PACKAGE, PACKAGE, 2, 2, 1, Set.of("release-certificate"), Set.of("release-certificate"));
    }
    @Test public void rejectsDifferentPackageAndVersionSubstitution() {
        assertThrows(SecurityException.class, () -> UpdatePolicy.requireIdentity("com.other.app", PACKAGE, 2, 2, 1, Set.of("cert"), Set.of("cert")));
        assertThrows(SecurityException.class, () -> UpdatePolicy.requireIdentity(PACKAGE, PACKAGE, 3, 2, 1, Set.of("cert"), Set.of("cert")));
    }
    @Test public void rejectsDowngradeAndReinstall() {
        for (int version : new int[] { 1, 2 }) {
            assertThrows(SecurityException.class, () -> UpdatePolicy.requireIdentity(PACKAGE, PACKAGE, version, version, 2, Set.of("cert"), Set.of("cert")));
        }
    }
    @Test public void rejectsWrongEmptyAndAdditionalSigningCertificates() {
        assertThrows(SecurityException.class, () -> UpdatePolicy.requireIdentity(PACKAGE, PACKAGE, 2, 2, 1, Set.of("owner"), Set.of("attacker")));
        assertThrows(SecurityException.class, () -> UpdatePolicy.requireIdentity(PACKAGE, PACKAGE, 2, 2, 1, Set.of(), Set.of()));
        assertThrows(SecurityException.class, () -> UpdatePolicy.requireIdentity(PACKAGE, PACKAGE, 2, 2, 1, Set.of("owner"), Set.of("owner", "attacker")));
    }
}
