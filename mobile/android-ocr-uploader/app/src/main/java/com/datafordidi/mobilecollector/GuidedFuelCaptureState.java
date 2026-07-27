package com.datafordidi.mobilecollector;

/**
 * 高德燃油悬浮采集的显式油号状态机。
 *
 * <p>状态只存在当前采集服务会话中；跳过不会产生或上传任何业务记录。
 */
final class GuidedFuelCaptureState {
    private Stage stage = Stage.GRADE_92;
    private String stationName = "";
    private String captureContextId = "";

    String expectedGrade() {
        if (stage == Stage.GRADE_92) return "92";
        if (stage == Stage.GRADE_95) return "95";
        return "";
    }

    boolean done() {
        return stage == Stage.DONE;
    }

    boolean acceptsStation(String candidate) {
        String normalized = FuelStationNameMatcher.normalize(candidate);
        return !normalized.isEmpty()
                && (stationName.isEmpty()
                || FuelStationNameMatcher.sameStation(stationName, candidate));
    }

    boolean hasStationBinding() {
        return !stationName.isEmpty();
    }

    boolean canonicalize(FuelStationRecord candidate) {
        if (candidate == null || !acceptsStation(candidate.stationName)) return false;
        if (stationName.isEmpty()) return true;
        String observed = candidate.stationName;
        if (!FuelStationNameMatcher.normalize(stationName)
                .equals(FuelStationNameMatcher.normalize(observed))) {
            if (candidate.observedStationName == null
                    || candidate.observedStationName.trim().isEmpty()) {
                candidate.observedStationName = observed;
            }
            candidate.stationNameMatchMethod = "guided-session-ocr-fuzzy";
        }
        candidate.stationName = stationName;
        if (!captureContextId.isEmpty()) candidate.captureContextId = captureContextId;
        return true;
    }

    boolean markCaptured(String grade, String candidate) {
        if (!expectedGrade().equals(grade) || !acceptsStation(candidate)) return false;
        if (stationName.isEmpty()) stationName = candidate == null ? "" : candidate.trim();
        advance();
        return true;
    }

    boolean markCaptured(String grade, FuelStationRecord candidate) {
        if (candidate == null || !expectedGrade().equals(grade)
                || !canonicalize(candidate)) {
            return false;
        }
        if (stationName.isEmpty()) stationName = candidate.stationName.trim();
        if (captureContextId.isEmpty()) {
            captureContextId = candidate.captureContextId == null
                    ? ""
                    : candidate.captureContextId.trim();
        }
        advance();
        return true;
    }

    boolean skip(String grade) {
        if (!expectedGrade().equals(grade)) return false;
        advance();
        return true;
    }

    void reset() {
        stage = Stage.GRADE_92;
        stationName = "";
        captureContextId = "";
    }

    private void advance() {
        if (stage == Stage.GRADE_92) stage = Stage.GRADE_95;
        else stage = Stage.DONE;
    }

    private enum Stage {
        GRADE_92,
        GRADE_95,
        DONE
    }
}
