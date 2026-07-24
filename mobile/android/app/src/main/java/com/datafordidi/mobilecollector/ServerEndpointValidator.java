package com.datafordidi.mobilecollector;

import java.net.URI;
import java.util.Locale;

final class ServerEndpointValidator {
    private ServerEndpointValidator() {
    }

    static String normalize(String value, String fallback) {
        String raw = value == null ? "" : value.trim();
        if (raw.isEmpty()) {
            raw = fallback == null ? "" : fallback.trim();
        }
        if (raw.isEmpty()) {
            throw new IllegalArgumentException("sync server URL is required");
        }
        if (!raw.matches("^[a-zA-Z][a-zA-Z0-9+.-]*://.*")) {
            raw = "http://" + raw;
        }

        try {
            URI uri = new URI(raw);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) {
                throw new IllegalArgumentException("sync server URL must use http or https");
            }
            if (uri.getHost() == null || uri.getHost().trim().isEmpty()) {
                throw new IllegalArgumentException("sync server URL must include a host");
            }
            if (uri.getRawUserInfo() != null) {
                throw new IllegalArgumentException("sync server URL must not contain credentials");
            }
            String path = uri.getRawPath();
            if (path != null && !path.isEmpty() && !"/".equals(path)) {
                throw new IllegalArgumentException("sync server URL must not contain a path");
            }
            if (uri.getRawQuery() != null || uri.getRawFragment() != null) {
                throw new IllegalArgumentException("sync server URL must not contain query or fragment data");
            }
            int port = uri.getPort();
            if (port == 0 || port > 65535) {
                throw new IllegalArgumentException("sync server URL contains an invalid port");
            }
            return new URI(scheme, null, uri.getHost(), port, null, null, null).toString();
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("sync server URL is invalid", error);
        }
    }
}
