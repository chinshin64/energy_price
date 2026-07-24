package com.datafordidi.mobilecollector;

import okhttp3.HttpUrl;

final class UploadEndpointPolicy {
    private UploadEndpointPolicy() {
    }

    static HttpUrl requireHttpsBaseUrl(String value) {
        HttpUrl url = HttpUrl.parse(normalize(value));
        if (url == null) throw new IllegalStateException("回传配置无效");
        if (!url.isHttps()) throw new IllegalStateException("回传必须使用 HTTPS");
        if (!url.username().isEmpty() || !url.password().isEmpty()) {
            throw new IllegalStateException("回传地址不能包含用户信息");
        }
        if (url.query() != null || url.fragment() != null || !"/".equals(url.encodedPath())) {
            throw new IllegalStateException("回传地址必须为服务根地址");
        }
        return url;
    }

    private static String normalize(String value) {
        String normalized = value == null ? "" : value.trim();
        return normalized.replaceAll("/+$", "");
    }
}
