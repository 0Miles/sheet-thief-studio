"""Stable, actionable project errors; internal exceptions belong in server logs."""


def recognition_error(pages: list[dict] | None = None, *, code: str = "recognition_failed") -> dict:
    pages = pages or []
    messages = {
        "recognition_failed": "樂譜辨識失敗，請確認圖片清楚且包含完整六線 TAB。",
        "interrupted": "辨識已中斷，請按「重新辨識」重試。",
        "timeout": "辨識時間超過限制，請裁切多餘背景或減少頁數後重試。",
        "busy": "辨識服務忙碌中，請稍後重試。",
    }
    message = messages.get(code, messages["recognition_failed"])
    if pages:
        descriptions = {
            "no_staff": "未偵測到六條平行弦線",
            "no_notes": "已找到弦線，但未能讀取格號",
            "invalid_image": "圖片無法解碼或檔案已損壞",
            "image_too_large": "圖片超過像素上限",
        }
        message = (
            "；".join(f"第 {item['page']} 頁：{descriptions.get(item['code'], '無法辨識 TAB')}" for item in pages)
            + "。本次未更新樂譜。"
        )
    suggestions = [
        "請使用正面、清楚的六線 TAB 圖片，保留完整弦線與格號。",
        "可裁切工具列或空白背景，調整圖片後再按「重新辨識」。",
    ]
    reasons = {item["code"] for item in pages}
    if "invalid_image" in reasons:
        suggestions.insert(0, "請將出錯圖片重新匯出為完整的 PNG、JPEG 或 WebP，再建立專案上傳。")
    if "image_too_large" in reasons:
        suggestions.insert(0, "請縮小出錯圖片的解析度或裁切多餘背景，再建立專案上傳。")
    return {
        "code": code,
        "message": message,
        "pages": pages,
        "suggestions": suggestions,
    }
