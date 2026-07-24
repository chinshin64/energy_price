package com.datafordidi.mobilecollector;

enum CaptureUiState {
    STOPPED("已停止", "开始识别", false, true),
    AWAITING_AUTH("待授权", "开始识别", false, true),
    STARTING("正在启动", "正在启动", false, false),
    RUNNING("识别中", "停止识别", true, true),
    STOPPING("正在停止", "正在停止", true, false),
    ERROR("启动失败", "重新开始", false, true);

    final String label;
    final String primaryLabel;
    final boolean stopAction;
    final boolean primaryEnabled;

    CaptureUiState(String label, String primaryLabel, boolean stopAction, boolean primaryEnabled) {
        this.label = label;
        this.primaryLabel = primaryLabel;
        this.stopAction = stopAction;
        this.primaryEnabled = primaryEnabled;
    }

    static CaptureUiState from(String status, boolean running, boolean awaitingReady) {
        String value = status == null ? "" : status.trim();
        if (value.contains("未授权") || value.contains("待授权") || value.contains("等待授权")) {
            return AWAITING_AUTH;
        }
        if (value.contains("启动失败") || value.contains("启动超时")) return ERROR;
        if (value.contains("正在停止")) return STOPPING;
        if (value.contains("已停止") || value.contains("录屏已停止")) return STOPPED;
        if (awaitingReady || value.contains("正在启动")) return STARTING;
        if (running || value.contains("采集中") || value.startsWith("识别")) return RUNNING;
        return STOPPED;
    }
}
