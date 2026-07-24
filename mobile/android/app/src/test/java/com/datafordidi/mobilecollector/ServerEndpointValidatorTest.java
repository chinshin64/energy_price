package com.datafordidi.mobilecollector;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class ServerEndpointValidatorTest {
    @Test
    public void normalizesHttpAndHttpsBaseUrls() {
        assertEquals(
                "http://127.0.0.1:50080",
                ServerEndpointValidator.normalize("127.0.0.1:50080/", "")
        );
        assertEquals(
                "https://collector.example.com",
                ServerEndpointValidator.normalize("https://collector.example.com/", "")
        );
    }

    @Test
    public void rejectsCredentialsPathsAndUnsupportedSchemes() {
        for (String value : new String[]{
                "ftp://collector.example.com",
                "https://user:pass@collector.example.com",
                "https://collector.example.com/api",
                "https://collector.example.com?token=value",
                "http://localhost:65536",
        }) {
            assertThrows(
                    IllegalArgumentException.class,
                    () -> ServerEndpointValidator.normalize(value, "")
            );
        }
    }
}
