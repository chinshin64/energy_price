package com.datafordidi.mobilecollector;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CaptureUiStateTest {
    @Test
    public void mapsInternalStatusesToCompactUserStates() {
        assertEquals(CaptureUiState.AWAITING_AUTH, CaptureUiState.from("未授权录屏", false, false));
        assertEquals(CaptureUiState.STARTING, CaptureUiState.from("正在启动", false, true));
        assertEquals(CaptureUiState.RUNNING, CaptureUiState.from("识别4条", true, false));
        assertEquals(CaptureUiState.STOPPING, CaptureUiState.from("正在停止", true, false));
        assertEquals(CaptureUiState.STOPPED, CaptureUiState.from("已停止", false, false));
        assertEquals(CaptureUiState.ERROR, CaptureUiState.from("启动超时", false, false));
    }

    @Test
    public void primaryActionIsSingleAndStateAware() {
        assertFalse(CaptureUiState.STOPPED.stopAction);
        assertTrue(CaptureUiState.RUNNING.stopAction);
        assertEquals("开始识别", CaptureUiState.STOPPED.primaryLabel);
        assertEquals("停止识别", CaptureUiState.RUNNING.primaryLabel);
        assertFalse(CaptureUiState.STARTING.primaryEnabled);
    }
}
