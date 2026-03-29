import asyncio
import json
import re
import time
from typing import Dict, List, Set

import websockets

WS_URL = "ws://127.0.0.1:48911/ws/%E6%B1%90%E9%9B%AA%E5%BF%83%E7%BC%98"

TEST_QUERIES = [
    "基于用户插件knowledge_base回答: 掺杂浓度（N_d/N_a）到短路电流密度（J_sc）的完整逻辑链是什么？",
    "基于用户插件knowledge_base回答: S(N_d) 的公式是什么？请给出可读表达式，不要 LaTeX 控制符。",
    "基于用户插件knowledge_base回答: J_sc 的公式是什么？请解释每个符号含义。",
]

LATEX_CMD_RE = re.compile(r"\\\\[a-zA-Z]+")


async def wait_for_session_started(ws, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=deadline - time.monotonic())
        msg = json.loads(raw)
        if msg.get("type") == "session_started":
            return
    raise TimeoutError("session_started timeout")


async def run_turn(ws, text: str, timeout: float = 45.0) -> Dict:
    t0 = time.monotonic()
    await ws.send(json.dumps({"action": "stream_data", "data": text, "input_type": "text"}, ensure_ascii=False))

    first_kb_running_at = None
    kb_task_ids: Set[str] = set()
    kb_updates: List[Dict] = []
    gemini_parts: List[str] = []
    last_activity = time.monotonic()
    saw_turn_end = False

    deadline = t0 + timeout
    while time.monotonic() < deadline:
        recv_timeout = min(2.0, max(0.1, deadline - time.monotonic()))
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=recv_timeout)
        except TimeoutError:
            # Some text sessions don't emit explicit turn-end consistently.
            # If we already got output and no activity for a short window, conclude this turn.
            if gemini_parts and (time.monotonic() - last_activity) > 2.0:
                break
            continue

        msg = json.loads(raw)
        mtype = msg.get("type")
        last_activity = time.monotonic()

        if mtype == "agent_task_update":
            task = msg.get("task") if isinstance(msg.get("task"), dict) else {}
            params = task.get("params") if isinstance(task.get("params"), dict) else {}
            if task.get("type") == "user_plugin" and params.get("plugin_id") == "knowledge_base" and params.get("entry_id") == "ask":
                kb_updates.append(task)
                task_id = str(task.get("id") or "")
                if task_id:
                    kb_task_ids.add(task_id)
                if task.get("status") == "running" and first_kb_running_at is None:
                    first_kb_running_at = time.monotonic()

        elif mtype == "gemini_response":
            txt = str(msg.get("text") or "")
            if txt:
                gemini_parts.append(txt)

        elif mtype == "system" and msg.get("data") == "turn end":
            saw_turn_end = True
            break

    final_text = "".join(gemini_parts).strip()
    return {
        "query": text,
        "kb_first_running_latency_s": None if first_kb_running_at is None else round(first_kb_running_at - t0, 3),
        "kb_task_update_count": len(kb_updates),
        "kb_unique_task_ids": sorted(kb_task_ids),
        "kb_unique_task_count": len(kb_task_ids),
        "has_duplicate_kb_task": len(kb_task_ids) > 1,
        "response_has_raw_latex_cmd": bool(LATEX_CMD_RE.search(final_text)),
        "saw_turn_end": saw_turn_end,
        "response_preview": final_text[:280],
    }


async def main() -> None:
    results: List[Dict] = []
    for q in TEST_QUERIES:
        async with websockets.connect(WS_URL, max_size=4 * 1024 * 1024) as ws:
            await ws.send(json.dumps({"action": "start_session", "input_type": "text"}, ensure_ascii=False))
            await wait_for_session_started(ws)
            r = await run_turn(ws, q)
            results.append(r)
            await ws.send(json.dumps({"action": "end_session"}, ensure_ascii=False))
            await asyncio.sleep(0.4)

    print(json.dumps({"ws": WS_URL, "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
