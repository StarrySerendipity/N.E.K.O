"""
Unit tests for the emoji_pusher plugin.

Tests cover:
- push_emoji: valid data, error cases (empty/invalid base64, bad extension, oversized)
- save_emoji / list_emojis / delete_emoji / push_saved_emoji
- _strip_data_uri helper
- _validate_image helper
- _ext_to_mime helper
"""
from __future__ import annotations

import base64
import tempfile
from pathlib import Path
from typing import Any

import pytest

from plugin.plugins.emoji_pusher import (
    EmojiPusherPlugin,
    _ext_to_mime,
    _strip_data_uri,
    _validate_image,
    _ALLOWED_EXTENSIONS,
    _MAX_SIZE_BYTES,
)
from plugin.sdk.plugin import Ok, Err


# ──────────────────────────── Mock context ────────────────────────────

class _Logger:
    def info(self, *args, **kwargs): ...
    def warning(self, *args, **kwargs): ...
    def error(self, *args, **kwargs): ...
    def debug(self, *args, **kwargs): ...
    def exception(self, *args, **kwargs): ...


class _MockCtx:
    plugin_id = "emoji_pusher"
    metadata: dict[str, Any] = {}
    bus = None

    def __init__(self) -> None:
        self.logger = _Logger()
        self._tmp = tempfile.mkdtemp()
        self.config_path = Path(self._tmp) / "plugin.toml"
        self._effective_config: dict[str, Any] = {
            "plugin": {"store": {"enabled": True}, "database": {"enabled": False}},
            "plugin_state": {"backend": "memory"},
        }
        # Capture push_message calls for assertions
        self.pushed_messages: list[dict[str, Any]] = []

    def push_message(self, **kwargs: Any) -> None:
        self.pushed_messages.append(dict(kwargs))

    async def get_own_config(self, timeout: float = 5.0) -> dict[str, Any]:
        return {"config": self._effective_config}

    async def trigger_plugin_event(self, **kwargs: Any) -> Any:
        return {"ok": True}

    async def update_own_config(self, updates: dict, timeout: float = 10.0) -> dict[str, Any]:
        return {"config": self._effective_config}


def _make_plugin() -> tuple[EmojiPusherPlugin, _MockCtx]:
    ctx = _MockCtx()
    plugin = EmojiPusherPlugin(ctx)
    return plugin, ctx


# ─── Minimal 1×1 PNG (binary) ────────────────────────────────────────
# A valid 1×1 transparent PNG encoded as base64.
_PNG_1x1_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
    "z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="
)
_PNG_1x1_BYTES = base64.b64decode(_PNG_1x1_B64)


# ──────────────────────────── Helper unit tests ────────────────────────────

class TestStripDataUri:
    def test_strips_data_uri_prefix(self):
        raw = "data:image/gif;base64,abc123=="
        assert _strip_data_uri(raw) == "abc123=="

    def test_returns_plain_b64_unchanged(self):
        raw = "abc123=="
        assert _strip_data_uri(raw) == "abc123=="

    def test_handles_whitespace(self):
        raw = "  data:image/png;base64,xyz  "
        assert _strip_data_uri(raw) == "xyz"

    def test_no_comma_returns_as_is(self):
        raw = "data:image/pngNOCOMMA"
        assert _strip_data_uri(raw) == "data:image/pngNOCOMMA"


class TestExtToMime:
    def test_png(self):
        assert _ext_to_mime(".png") == "image/png"

    def test_gif(self):
        assert _ext_to_mime(".gif") == "image/gif"

    def test_jpg(self):
        assert _ext_to_mime(".jpg") == "image/jpeg"

    def test_jpeg(self):
        assert _ext_to_mime(".jpeg") == "image/jpeg"

    def test_webp(self):
        assert _ext_to_mime(".webp") == "image/webp"

    def test_bmp(self):
        assert _ext_to_mime(".bmp") == "image/bmp"

    def test_unknown_returns_octet(self):
        assert _ext_to_mime(".xyz") == "application/octet-stream"


class TestValidateImage:
    def test_valid_png(self):
        result_bytes, ext = _validate_image(_PNG_1x1_B64, "test.png")
        assert result_bytes == _PNG_1x1_BYTES
        assert ext == ".png"

    def test_strips_data_uri_prefix(self):
        with_prefix = f"data:image/png;base64,{_PNG_1x1_B64}"
        result_bytes, ext = _validate_image(with_prefix, "test.png")
        assert result_bytes == _PNG_1x1_BYTES

    def test_empty_b64_returns_none(self):
        result, msg = _validate_image("", "test.png")
        assert result is None
        assert "不能为空" in msg

    def test_whitespace_only_b64_returns_none(self):
        result, msg = _validate_image("   ", "test.png")
        assert result is None
        assert "不能为空" in msg

    def test_invalid_extension_returns_none(self):
        result, msg = _validate_image(_PNG_1x1_B64, "test.txt")
        assert result is None
        assert ".txt" in msg

    def test_unsupported_extension_mp4(self):
        result, msg = _validate_image(_PNG_1x1_B64, "clip.mp4")
        assert result is None
        assert ".mp4" in msg

    def test_invalid_base64_returns_none(self):
        result, msg = _validate_image("not!valid!base64!!!", "test.png")
        assert result is None
        assert "解码失败" in msg

    def test_oversized_returns_none(self):
        # Generate bytes just over the limit
        big_bytes = b"\xff" * (_MAX_SIZE_BYTES + 1)
        big_b64 = base64.b64encode(big_bytes).decode("ascii")
        result, msg = _validate_image(big_b64, "big.png")
        assert result is None
        assert "超过限制" in msg

    def test_exactly_at_limit_is_ok(self):
        # Exactly at limit should pass
        limit_bytes = b"\xff" * _MAX_SIZE_BYTES
        limit_b64 = base64.b64encode(limit_bytes).decode("ascii")
        result, ext = _validate_image(limit_b64, "max.png")
        assert result is not None
        assert len(result) == _MAX_SIZE_BYTES


# ──────────────────────────── Plugin entry tests ────────────────────────────

class TestPushEmoji:
    def test_push_valid_png(self):
        plugin, ctx = _make_plugin()
        result = plugin.push_emoji(image_base64=_PNG_1x1_B64, filename="test.png")
        assert isinstance(result, Ok), f"expected Ok, got {result}"
        assert result.value["pushed"] is True
        assert result.value["filename"] == "test.png"
        assert len(ctx.pushed_messages) == 1
        msg = ctx.pushed_messages[0]
        assert msg["source"] == "emoji_pusher"
        assert msg["message_type"] == "binary"
        assert msg["binary_data"] == _PNG_1x1_BYTES

    def test_push_with_data_uri_prefix(self):
        plugin, ctx = _make_plugin()
        with_prefix = f"data:image/png;base64,{_PNG_1x1_B64}"
        result = plugin.push_emoji(image_base64=with_prefix, filename="test.png")
        assert isinstance(result, Ok)
        assert ctx.pushed_messages[0]["binary_data"] == _PNG_1x1_BYTES

    def test_push_with_custom_description(self):
        plugin, ctx = _make_plugin()
        result = plugin.push_emoji(
            image_base64=_PNG_1x1_B64,
            filename="hello.png",
            description="Custom desc",
        )
        assert isinstance(result, Ok)
        assert ctx.pushed_messages[0]["description"] == "Custom desc"

    def test_push_uses_filename_in_description_when_no_description(self):
        plugin, ctx = _make_plugin()
        plugin.push_emoji(image_base64=_PNG_1x1_B64, filename="smile.png")
        assert "smile.png" in ctx.pushed_messages[0]["description"]

    def test_push_empty_b64_returns_err(self):
        plugin, ctx = _make_plugin()
        result = plugin.push_emoji(image_base64="", filename="test.png")
        assert isinstance(result, Err)
        assert len(ctx.pushed_messages) == 0

    def test_push_invalid_b64_returns_err(self):
        plugin, ctx = _make_plugin()
        result = plugin.push_emoji(image_base64="$$$INVALID$$$", filename="test.png")
        assert isinstance(result, Err)
        assert len(ctx.pushed_messages) == 0

    def test_push_bad_extension_returns_err(self):
        plugin, ctx = _make_plugin()
        result = plugin.push_emoji(image_base64=_PNG_1x1_B64, filename="test.exe")
        assert isinstance(result, Err)
        assert "不支持" in str(result.error) or "exe" in str(result.error).lower()
        assert len(ctx.pushed_messages) == 0

    def test_push_oversized_returns_err(self):
        plugin, ctx = _make_plugin()
        big_bytes = b"\x00" * (_MAX_SIZE_BYTES + 1)
        big_b64 = base64.b64encode(big_bytes).decode("ascii")
        result = plugin.push_emoji(image_base64=big_b64, filename="big.png")
        assert isinstance(result, Err)
        assert len(ctx.pushed_messages) == 0

    def test_metadata_contains_filename_and_content_type(self):
        plugin, ctx = _make_plugin()
        plugin.push_emoji(image_base64=_PNG_1x1_B64, filename="icon.gif")
        meta = ctx.pushed_messages[0]["metadata"]
        assert meta["filename"] == "icon.gif"
        assert meta["content_type"] == "image/gif"

    def test_default_filename_used_when_empty(self):
        plugin, ctx = _make_plugin()
        result = plugin.push_emoji(image_base64=_PNG_1x1_B64, filename="")
        # Empty filename falls back to "emoji.png" — extension is .png (allowed)
        assert isinstance(result, Ok)


class TestGalleryManagement:
    def test_list_emojis_empty_initially(self):
        plugin, _ = _make_plugin()
        result = plugin.list_emojis()
        assert isinstance(result, Ok)
        assert result.value["count"] == 0
        assert result.value["emojis"] == []

    def test_save_and_list(self):
        plugin, _ = _make_plugin()
        save_result = plugin.save_emoji(
            image_base64=_PNG_1x1_B64,
            filename="happy.png",
            label="Happy face",
        )
        assert isinstance(save_result, Ok)
        assert save_result.value["saved"] is True
        emoji_id = save_result.value["emoji_id"]
        assert isinstance(emoji_id, str) and emoji_id

        list_result = plugin.list_emojis()
        assert isinstance(list_result, Ok)
        assert list_result.value["count"] == 1
        item = list_result.value["emojis"][0]
        assert item["id"] == emoji_id
        assert item["filename"] == "happy.png"
        assert item["label"] == "Happy face"

    def test_delete_removes_item(self):
        plugin, _ = _make_plugin()
        save_result = plugin.save_emoji(image_base64=_PNG_1x1_B64, filename="a.png")
        eid = save_result.value["emoji_id"]

        del_result = plugin.delete_emoji(emoji_id=eid)
        assert isinstance(del_result, Ok)
        assert del_result.value["deleted"] == eid
        assert del_result.value["remaining"] == 0

        list_result = plugin.list_emojis()
        assert list_result.value["count"] == 0

    def test_delete_nonexistent_returns_err(self):
        plugin, _ = _make_plugin()
        result = plugin.delete_emoji(emoji_id="doesnotexist")
        assert isinstance(result, Err)

    def test_delete_empty_id_returns_err(self):
        plugin, _ = _make_plugin()
        result = plugin.delete_emoji(emoji_id="")
        assert isinstance(result, Err)

    def test_push_saved_emoji(self):
        plugin, ctx = _make_plugin()
        plugin.save_emoji(image_base64=_PNG_1x1_B64, filename="saved.png", label="My emoji")
        eid = plugin.list_emojis().value["emojis"][0]["id"]

        push_result = plugin.push_saved_emoji(emoji_id=eid)
        assert isinstance(push_result, Ok)
        assert push_result.value["pushed"] is True
        assert len(ctx.pushed_messages) == 1
        assert ctx.pushed_messages[0]["binary_data"] == _PNG_1x1_BYTES

    def test_push_saved_emoji_uses_label_in_description(self):
        plugin, ctx = _make_plugin()
        plugin.save_emoji(image_base64=_PNG_1x1_B64, filename="x.png", label="My label")
        eid = plugin.list_emojis().value["emojis"][0]["id"]
        plugin.push_saved_emoji(emoji_id=eid)
        assert "My label" in ctx.pushed_messages[0]["description"]

    def test_push_saved_emoji_with_custom_description(self):
        plugin, ctx = _make_plugin()
        plugin.save_emoji(image_base64=_PNG_1x1_B64, filename="x.png")
        eid = plugin.list_emojis().value["emojis"][0]["id"]
        plugin.push_saved_emoji(emoji_id=eid, description="Override desc")
        assert ctx.pushed_messages[0]["description"] == "Override desc"

    def test_push_saved_emoji_nonexistent_returns_err(self):
        plugin, ctx = _make_plugin()
        result = plugin.push_saved_emoji(emoji_id="no-such-id")
        assert isinstance(result, Err)
        assert len(ctx.pushed_messages) == 0

    def test_save_invalid_b64_returns_err(self):
        plugin, _ = _make_plugin()
        result = plugin.save_emoji(image_base64="$$$INVALID$$$", filename="x.png")
        assert isinstance(result, Err)

    def test_save_bad_extension_returns_err(self):
        plugin, _ = _make_plugin()
        result = plugin.save_emoji(image_base64=_PNG_1x1_B64, filename="x.mp4")
        assert isinstance(result, Err)


class TestLifecycle:
    def test_startup_returns_ok_with_ready_status(self):
        plugin, _ = _make_plugin()
        result = plugin.on_startup()
        assert isinstance(result, Ok)
        assert result.value["status"] == "ready"

    def test_shutdown_returns_ok(self):
        plugin, _ = _make_plugin()
        plugin.on_startup()
        result = plugin.on_shutdown()
        assert isinstance(result, Ok)
        assert result.value["status"] == "stopped"
