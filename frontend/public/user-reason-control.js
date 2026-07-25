(function attachUserReasonControl(global) {
    'use strict';

    const BASE_REASON_LABELS = {
        ready: '已准备好',
        success: '执行完成',
        unknown_error: '出现未知问题',
        wechat_not_running: '未检测到电脑端微信，请先打开微信',
        wechat_window_found: '已检测到微信窗口',
        target_window_found: '已检测到目标小程序页面',
        target_window_missing: '未找到目标小程序页面，请先打开目标页面',
        screenshot_ready: '截图能力可用',
        screenshot_failed: '截图失败，请检查屏幕录制权限',
        permission_denied: '系统权限不足，请检查屏幕录制和辅助功能权限',
        ocr_ready: '页面识别能力可用',
        ocr_unavailable: '页面识别不可用，请检查识别组件或系统权限',
        scroll_script_ready: '下滑脚本可用',
        scroll_script_missing: '缺少下滑脚本',
        scroll_failed: '下滑失败，请确认微信窗口在前台',
        page_not_recognized: '未能识别当前页面，请确认页面已打开且无遮挡',
        city_selector_not_found: '未找到城市入口，请确认当前页面支持切换城市',
        city_input_failed: '城市输入失败，请手动确认输入框是否可用',
        city_input_not_applied: '已尝试输入，但小程序搜索框没有识别到目标城市或场站',
        input_permission_denied: '当前桌面会话未开启辅助访问权限，无法向微信小程序搜索框输入城市或场站',
        city_result_not_found: '未找到目标城市结果',
        city_switch_verify_failed: '城市切换后未能确认结果，请人工核对页面',
        recorder_ready: '请求记录服务可用',
        recorder_running: '正在记录请求',
        recorder_start_failed: '请求记录启动失败',
        recorder_stop_failed: '请求记录停止失败',
        recorder_already_running: '已有请求记录会话正在运行，请先停止后再执行自动采集',
        page_automation_unavailable: '页面采集服务不可用',
        page_operation_failed: '小程序页面操作失败',
        proxy_not_checked: '网络出口未检查',
        proxy_configured: '网络出口已配置',
        proxy_not_configured: '网络出口未配置，请确认本次请求采集的网络设置',
        har_output_ready: '请求记录文件可写入',
        har_output_unwritable: '请求记录文件不可写入',
        har_not_found: '未找到请求记录文件',
        har_parse_failed: '请求记录解析失败',
        har_import_failed: '请求记录解析后入库失败',
        no_request_captured: '没有记录到请求，请确认操作期间有网络请求',
        no_target_request_detected: '没有发现目标业务请求，请确认操作是否触发了目标页面',
        auto_capture_import_completed: '自动操控、请求采集、解析和入库已完成',
        page_operation_completed: '小程序页面操作已完成',
        certificate_not_trusted: '证书未被信任，可能无法解析加密请求',
        tls_not_decryptable: '加密请求无法解析',
        template_missing: '请求材料缺失，需要先验证或导入材料',
        signature_corpus_missing: '历史请求材料缺失',
        signed_template_target_mismatch: '请求材料与当前目标不匹配，需要重新采集当前目标材料',
        live_request_material_missing: '缺少当前目标的实时请求材料',
        request_limit_exceeded: '访问已自动停止，请缩小范围后重试',
        target_scope_required: '缺少验证范围，请先选择目标城市或坐标',
        target_scope_violation: '目标超出授权验证范围',
        request_failed: '请求失败',
        response_parse_failed: '响应解析失败',
        no_data_returned: '未返回有效数据',
        ai_agent_disabled: '智能诊断未启用',
        ai_agent_not_configured: '智能诊断未配置，请在系统设置中补齐模型服务信息',
        ai_agent_configured: '智能诊断已配置',
        ai_agent_request_failed: '智能诊断请求失败',
        ai_agent_timeout: '智能诊断超时',
        ai_agent_invalid_json: '智能诊断返回格式异常',
        ai_agent_empty_response: '智能诊断未返回结果',
        ai_agent_type_unsupported: '智能诊断类型不支持',
        bottom_reached: '已到达列表底部',
        max_scrolls_reached: '已达到最大下滑次数',
        max_steps_reached: '已达到最大操作步数',
        login_prompt_detected: '检测到登录提示，需要人工处理',
        network_error: '检测到网络异常'
    };

    function createFormatter(options = {}) {
        const labels = {
            ...BASE_REASON_LABELS,
            ...(options.labels && typeof options.labels === 'object' ? options.labels : {})
        };

        function productizeReason(reason) {
            const key = String(reason || '').trim();
            return labels[key] || key || '未知状态';
        }

        function formatUserReason(reason, { includeTech = false } = {}) {
            const friendly = productizeReason(reason);
            const tech = String(reason || '').trim();
            if (!includeTech || !tech || friendly === tech) {
                return friendly;
            }
            return `${friendly}（技术详情：${tech}）`;
        }

        function productizeReasonList(value) {
            if (Array.isArray(value)) {
                return value.map(item => productizeReason(item)).join('、');
            }
            return productizeReason(value);
        }

        return {
            formatUserReason,
            productizeReason,
            productizeReasonList
        };
    }

    global.UserReasonControl = { createFormatter };
})(window);
