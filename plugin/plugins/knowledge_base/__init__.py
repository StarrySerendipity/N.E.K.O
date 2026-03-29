"""极简知识库插件：多文档 Markdown 向量检索 + RAG 问答（硅基流动）。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import sqlite3
import threading
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple

import httpx

from plugin.sdk.plugin import (
    Err,
    NekoPluginBase,
    Ok,
    SdkError,
    lifecycle,
    neko_plugin,
    plugin_entry,
)

_DB_FILENAME = "knowledge_base.sqlite3"
_DOCS_DIRNAME = "kb_docs"
_DEFAULT_CHUNK_SIZE = 900
_DEFAULT_CHUNK_OVERLAP = 180
_DEFAULT_TOP_K = 4
_MIN_RELEVANCE_SCORE = 0.38
_EMBED_BATCH_SIZE = 4
_EMBED_MAX_RETRIES = 2
_EMBED_REQUEST_TIMEOUT_SEC = 8.0
_EMBED_CONNECT_TIMEOUT_SEC = 4.0
_FALLBACK_VECTOR_DIM = 256


@dataclass(frozen=True)
class KBConfig:
    base_url: str
    api_key: str
    chat_model: str
    embedding_model: str


def _markdown_to_text(markdown_text: str) -> str:
    text = markdown_text.replace("\r\n", "\n")
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    text = re.sub(r"`[^`]*`", " ", text)
    text = re.sub(r"!\[[^\]]*\]\([^\)]*\)", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^\)]*\)", r"\1", text)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[\-\*\+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def _chunk_text(text: str, chunk_size: int, overlap: int) -> List[str]:
    if not text:
        return []

    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: List[str] = []
    current = ""

    for para in paragraphs:
        if len(para) > chunk_size:
            words = para.split()
            seg = ""
            for word in words:
                candidate = f"{seg} {word}".strip()
                if len(candidate) <= chunk_size:
                    seg = candidate
                else:
                    if seg:
                        chunks.append(seg)
                    seg = word
            if seg:
                chunks.append(seg)
            continue

        candidate = f"{current}\n\n{para}".strip() if current else para
        if len(candidate) <= chunk_size:
            current = candidate
        else:
            if current:
                chunks.append(current)
            current = para

    if current:
        chunks.append(current)

    if overlap <= 0 or len(chunks) <= 1:
        return chunks

    merged: List[str] = [chunks[0]]
    for idx in range(1, len(chunks)):
        prefix = chunks[idx - 1]
        suffix = chunks[idx]
        keep = prefix[-overlap:] if len(prefix) > overlap else prefix
        merged.append(f"{keep}\n{suffix}".strip())
    return merged


def _cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    if len(a) != len(b) or not a:
        return -1.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return -1.0
    return dot / (norm_a * norm_b)


def _extract_next_sentence(text: str, anchor: str) -> str | None:
    if not text or not anchor:
        return None
    pos = text.find(anchor)
    if pos < 0:
        return None
    tail = text[pos + len(anchor) :].strip()
    if not tail:
        return None

    m = re.search(r"([。！？!?\n])", tail)
    if not m:
        return tail[:80].strip() or None
    return tail[: m.start()].strip() or None


def _build_retrieval_fallback_answer(question: str, chosen: List[Tuple[float, str, int, str]]) -> str:
    q = (question or "").strip()
    if not chosen:
        return "文档中没有足够信息。"

    # Handle common pattern: “XXX的下一句是什么？”
    m = re.search(r"(.+?)的下一句", q)
    if m:
        anchor = m.group(1).strip("“”\"'：:，,。！？!? ")
        if anchor:
            for _, _, _, text in chosen:
                nxt = _extract_next_sentence(text, anchor)
                if nxt:
                    return f"根据文档，\"{anchor}\" 的下一句是：{nxt}"

    preview = (chosen[0][3] or "").strip()
    if not preview:
        return "文档中没有足够信息。"
    preview = re.sub(r"\s+", " ", preview)
    return f"已命中文档片段：{preview[:180]}"


def _lexical_score(question: str, text: str) -> float:
    q = (question or "").strip()
    t = (text or "").strip()
    if not q or not t:
        return 0.0

    # Strong bonus when question appears verbatim in chunk.
    if q in t:
        return 1.0

    q_norm = re.sub(r"\s+", "", q)
    t_norm = re.sub(r"\s+", "", t)
    if not q_norm or not t_norm:
        return 0.0

    # CJK-friendly overlap by unique non-punctuation characters.
    q_chars = {c for c in q_norm if c not in "，。！？；：、,.!?;:'\"（）()[]{}<>《》“”‘’|-_+*/\\\n\t\r"}
    t_chars = {c for c in t_norm if c not in "，。！？；：、,.!?;:'\"（）()[]{}<>《》“”‘’|-_+*/\\\n\t\r"}
    if not q_chars or not t_chars:
        return 0.0
    overlap = len(q_chars & t_chars)
    return overlap / max(1, len(q_chars))


def _fallback_embedding(text: str, dim: int = _FALLBACK_VECTOR_DIM) -> List[float]:
    """Build a deterministic local vector when upstream embedding is unavailable."""
    vec = [0.0] * dim
    norm_text = re.sub(r"\s+", "", text or "")
    if not norm_text:
        return vec

    for ch in norm_text:
        digest = hashlib.sha256(ch.encode("utf-8", errors="ignore")).digest()
        idx = int.from_bytes(digest[:4], byteorder="big", signed=False) % dim
        vec[idx] += 1.0

    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


@neko_plugin
class KnowledgeBasePlugin(NekoPluginBase):
    """极简本地知识库插件（支持多 Markdown 文档）。"""

    def __init__(self, ctx: Any):
        super().__init__(ctx)
        self.file_logger = self.enable_file_logging(log_level="INFO")
        self.logger = self.file_logger
        self._db_lock = threading.Lock()
        self._db_path: Path = self.data_path(_DB_FILENAME)
        self._docs_dir: Path = self.data_path(_DOCS_DIRNAME)
        self._cfg: KBConfig | None = None

    @lifecycle(id="startup")
    async def startup(self, **_):
        cfg_dump = await self.config.dump(timeout=5.0)
        cfg_dump = cfg_dump if isinstance(cfg_dump, dict) else {}
        raw_section = cfg_dump.get("knowledge_base")
        raw_cfg: Dict[str, Any] = raw_section if isinstance(raw_section, dict) else {}

        self._cfg = KBConfig(
            base_url=str(raw_cfg.get("base_url", "")).strip(),
            api_key=str(raw_cfg.get("api_key", "")).strip(),
            chat_model=str(raw_cfg.get("chat_model", "")).strip(),
            embedding_model=str(raw_cfg.get("embedding_model", "")).strip(),
        )

        self._init_db()
        self._docs_dir.mkdir(parents=True, exist_ok=True)

        configured = self._is_cfg_ready()
        if configured:
            self.logger.info("KnowledgeBase startup complete and configured")
        else:
            self.logger.warning("KnowledgeBase startup complete but config is incomplete")

        return Ok({"status": "ready", "configured": configured})

    @lifecycle(id="shutdown")
    def shutdown(self, **_):
        self.logger.info("KnowledgeBase shutdown")
        return Ok({"status": "stopped"})

    @plugin_entry(
        id="upload_markdown",
        name="上传 Markdown",
        description="上传并索引 Markdown 文档（支持多文档累计）",
        timeout=120.0,
        llm_result_fields=["message", "document_name", "chunk_count", "document_total", "chunk_total"],
        input_schema={
            "type": "object",
            "required": ["markdown_text"],
            "properties": {
                "markdown_text": {"type": "string", "description": "Markdown 原文"},
                "document_name": {"type": "string", "description": "文档名称", "default": "document.md"},
            },
        },
    )
    async def upload_markdown(self, markdown_text: str, document_name: str = "document.md", **_):
        cfg_err = self._ensure_cfg_ready()
        if cfg_err:
            return cfg_err

        clean_name = self._normalize_document_name(document_name)
        text = _markdown_to_text(markdown_text)
        if not text:
            return Err(SdkError("Markdown 文本为空，无法建立知识库"))

        chunks = _chunk_text(text, _DEFAULT_CHUNK_SIZE, _DEFAULT_CHUNK_OVERLAP)
        if not chunks:
            return Err(SdkError("无法从 Markdown 提取有效文本分块"))

        embed_res = await self._embed_texts(chunks)
        if isinstance(embed_res, Err):
            return embed_res

        vectors = embed_res.value
        self._save_markdown_file(document_name=clean_name, markdown_text=markdown_text)
        self._upsert_document(document_name=clean_name, chunks=chunks, vectors=vectors)
        doc_total, chunk_total = self._get_library_stats()

        return Ok(
            {
                "message": "Markdown 上传并向量化完成",
                "document_name": clean_name,
                "chunk_count": len(chunks),
                "document_total": doc_total,
                "chunk_total": chunk_total,
                "embedding_model": self._cfg.embedding_model if self._cfg else "",
            }
        )

    @plugin_entry(
        id="ask",
        name="知识库问答",
        description="基于已上传 Markdown 文档进行检索增强问答",
        timeout=180.0,
        llm_result_fields=["answer", "question", "citations"],
        input_schema={
            "type": "object",
            "required": ["question"],
            "properties": {
                "question": {"type": "string", "description": "用户问题"},
                "top_k": {"type": "integer", "description": "检索片段数量", "default": _DEFAULT_TOP_K},
            },
        },
    )
    async def ask(self, question: str, top_k: int = _DEFAULT_TOP_K, **_):
        cfg_err = self._ensure_cfg_ready()
        if cfg_err:
            return cfg_err

        q = question.strip()
        if not q:
            return Err(SdkError("问题不能为空"))

        rows = self._load_all_chunks()
        if not rows:
            return Err(SdkError("知识库为空，请先调用 upload_markdown 上传文档"))

        q_embed_res = await self._embed_texts([q])
        scored: List[Tuple[float, str, int, str]] = []

        if isinstance(q_embed_res, Err):
            self.logger.warning("ask fallback to lexical retrieval: %s", str(q_embed_res.error))
            for document_name, chunk_index, chunk_text, _chunk_vector in rows:
                score = _lexical_score(q, chunk_text)
                scored.append((score, document_name, chunk_index, chunk_text))
        else:
            q_vec = q_embed_res.value[0]
            for document_name, chunk_index, chunk_text, chunk_vector in rows:
                score = _cosine_similarity(q_vec, chunk_vector)
                if score < 0.0:
                    # Mixed vector dimensions (remote/local fallback) should still be searchable.
                    score = 0.95 * _lexical_score(q, chunk_text)
                scored.append((score, document_name, chunk_index, chunk_text))

        scored.sort(key=lambda item: item[0], reverse=True)
        chosen = scored[: max(1, min(top_k, 8))]

        best_score = chosen[0][0] if chosen else -1.0
        if best_score < _MIN_RELEVANCE_SCORE:
            return Ok(
                {
                    "answer": "文档中没有足够信息。",
                    "question": q,
                    "top_k": 0,
                    "citations": [],
                    "matched_documents": [],
                    "chat_model": self._cfg.chat_model if self._cfg else "",
                }
            )

        context_parts = [f"[文档: {doc} | 片段 {idx}]\n{text}" for _, doc, idx, text in chosen]
        context_text = "\n\n".join(context_parts)

        answer_res = await self._chat_with_context(question=q, context_text=context_text)
        answer_text = ""
        if isinstance(answer_res, Err):
            self.logger.warning("chat fallback to retrieval-only answer: %s", str(answer_res.error))
            answer_text = _build_retrieval_fallback_answer(q, chosen)
        else:
            answer_text = answer_res.value

        citations = [
            {
                "document_name": doc,
                "chunk_index": idx,
                "score": round(score, 6),
                "preview": text[:160],
            }
            for score, doc, idx, text in chosen
        ]
        matched_documents = sorted({doc for _, doc, _, _ in chosen})

        return Ok(
            {
                "answer": answer_text,
                "question": q,
                "top_k": len(chosen),
                "citations": citations,
                "matched_documents": matched_documents,
                "chat_model": self._cfg.chat_model if self._cfg else "",
            }
        )

    @plugin_entry(
        id="list_documents",
        name="查看已收录文档",
        description="查看知识库当前已收录的 Markdown 文档列表",
        timeout=30.0,
        llm_result_fields=["document_total", "documents"],
        input_schema={
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "返回条数上限", "default": 50},
            },
        },
    )
    async def list_documents(self, limit: int = 50, **_):
        safe_limit = max(1, min(int(limit), 200))
        docs = self._list_documents(limit=safe_limit)
        return Ok(
            {
                "document_total": len(docs),
                "documents": docs,
            }
        )

    @plugin_entry(
        id="delete_document",
        name="删除已收录文档",
        description="从知识库删除指定 Markdown 文档及其向量索引",
        timeout=30.0,
        llm_result_fields=["message", "deleted", "document_name", "document_total", "chunk_total"],
        input_schema={
            "type": "object",
            "required": ["document_name"],
            "properties": {
                "document_name": {"type": "string", "description": "要删除的文档名（精确匹配）"},
            },
        },
    )
    async def delete_document(self, document_name: str, **_):
        normalized = self._normalize_document_name(document_name)
        deleted = self._delete_document(normalized)
        doc_total, chunk_total = self._get_library_stats()

        if deleted:
            return Ok(
                {
                    "message": "文档删除完成",
                    "deleted": True,
                    "document_name": normalized,
                    "document_total": doc_total,
                    "chunk_total": chunk_total,
                }
            )

        return Ok(
            {
                "message": "未找到要删除的文档",
                "deleted": False,
                "document_name": normalized,
                "document_total": doc_total,
                "chunk_total": chunk_total,
            }
        )

    def _is_cfg_ready(self) -> bool:
        if self._cfg is None:
            return False
        return all(
            [
                self._cfg.base_url,
                self._cfg.api_key,
                self._cfg.chat_model,
                self._cfg.embedding_model,
            ]
        )

    def _ensure_cfg_ready(self) -> Err | None:
        if self._is_cfg_ready():
            return None
        return Err(
            SdkError(
                "知识库插件配置不完整，请在 [knowledge_base] 中填写 base_url / api_key / chat_model / embedding_model"
            )
        )

    def _init_db(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._db_lock:
            conn = sqlite3.connect(self._db_path)
            try:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS kb_documents (
                        document_name TEXT PRIMARY KEY,
                        file_path TEXT NOT NULL,
                        chunk_count INTEGER NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS kb_chunks (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        document_name TEXT NOT NULL,
                        chunk_index INTEGER NOT NULL,
                        content TEXT NOT NULL,
                        embedding_json TEXT NOT NULL,
                        FOREIGN KEY(document_name) REFERENCES kb_documents(document_name)
                    )
                    """
                )
                self._migrate_legacy_schema(conn)
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_kb_chunks_document_name ON kb_chunks(document_name)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_kb_chunks_chunk_index ON kb_chunks(chunk_index)"
                )
                conn.commit()
            finally:
                conn.close()

    def _migrate_legacy_schema(self, conn: sqlite3.Connection) -> None:
        cols = [str(row[1]) for row in conn.execute("PRAGMA table_info(kb_chunks)").fetchall()]
        if not cols or "id" in cols:
            return

        conn.execute("ALTER TABLE kb_chunks RENAME TO kb_chunks_legacy")
        conn.execute(
            """
            CREATE TABLE kb_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_name TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                embedding_json TEXT NOT NULL,
                FOREIGN KEY(document_name) REFERENCES kb_documents(document_name)
            )
            """
        )

        legacy_rows = conn.execute(
            "SELECT chunk_index, document_name, content, embedding_json FROM kb_chunks_legacy ORDER BY chunk_index ASC"
        ).fetchall()
        for chunk_index, document_name, content, embedding_json in legacy_rows:
            safe_doc = self._normalize_document_name(str(document_name))
            conn.execute(
                "INSERT INTO kb_chunks(document_name, chunk_index, content, embedding_json) VALUES(?, ?, ?, ?)",
                (safe_doc, int(chunk_index), str(content), str(embedding_json)),
            )

        grouped = conn.execute(
            "SELECT document_name, COUNT(*) AS cnt FROM kb_chunks GROUP BY document_name"
        ).fetchall()
        now = datetime.now(timezone.utc).isoformat()
        for doc_name, cnt in grouped:
            fallback_path = str((self._docs_dir / doc_name).as_posix())
            conn.execute(
                """
                INSERT OR IGNORE INTO kb_documents(document_name, file_path, chunk_count, updated_at)
                VALUES(?, ?, ?, ?)
                """,
                (str(doc_name), fallback_path, int(cnt), now),
            )

        conn.execute("DROP TABLE kb_chunks_legacy")

    def _save_markdown_file(self, document_name: str, markdown_text: str) -> Path:
        self._docs_dir.mkdir(parents=True, exist_ok=True)
        file_path = self._docs_dir / document_name
        file_path.write_text(markdown_text, encoding="utf-8")
        return file_path

    def _normalize_document_name(self, document_name: str) -> str:
        candidate = Path(str(document_name)).name.strip()
        if not candidate:
            candidate = "document.md"

        candidate = re.sub(r"[\\/:*?\"<>|]+", "_", candidate)
        if not candidate.lower().endswith((".md", ".markdown")):
            candidate = f"{candidate}.md"

        if len(candidate) > 180:
            suffix = ".md" if candidate.lower().endswith(".md") else ".markdown"
            keep_len = max(1, 180 - len(suffix))
            candidate = f"{candidate[:keep_len]}{suffix}"
        return candidate

    def _upsert_document(self, document_name: str, chunks: List[str], vectors: List[List[float]]) -> None:
        now = datetime.now(timezone.utc).isoformat()
        file_path = str((self._docs_dir / document_name).as_posix())
        with self._db_lock:
            conn = sqlite3.connect(self._db_path)
            try:
                conn.execute("DELETE FROM kb_chunks WHERE document_name = ?", (document_name,))
                for idx, (chunk, vector) in enumerate(zip(chunks, vectors)):
                    conn.execute(
                        "INSERT INTO kb_chunks(document_name, chunk_index, content, embedding_json) VALUES(?, ?, ?, ?)",
                        (document_name, idx, chunk, json.dumps(vector, ensure_ascii=False)),
                    )
                conn.execute(
                    """
                    INSERT INTO kb_documents(document_name, file_path, chunk_count, updated_at)
                    VALUES(?, ?, ?, ?)
                    ON CONFLICT(document_name) DO UPDATE SET
                        file_path = excluded.file_path,
                        chunk_count = excluded.chunk_count,
                        updated_at = excluded.updated_at
                    """,
                    (document_name, file_path, len(chunks), now),
                )
                conn.commit()
            finally:
                conn.close()

    def _get_library_stats(self) -> Tuple[int, int]:
        with self._db_lock:
            conn = sqlite3.connect(self._db_path)
            try:
                cur = conn.execute("SELECT COUNT(*), COALESCE(SUM(chunk_count), 0) FROM kb_documents")
                row = cur.fetchone()
            finally:
                conn.close()

        if not row:
            return (0, 0)
        return (int(row[0]), int(row[1]))

    def _load_all_chunks(self) -> List[Tuple[str, int, str, List[float]]]:
        with self._db_lock:
            conn = sqlite3.connect(self._db_path)
            try:
                cur = conn.execute(
                    """
                    SELECT document_name, chunk_index, content, embedding_json
                    FROM kb_chunks
                    ORDER BY document_name ASC, chunk_index ASC
                    """
                )
                rows = cur.fetchall()
            finally:
                conn.close()

        parsed: List[Tuple[str, int, str, List[float]]] = []
        for document_name, chunk_index, content, embedding_json in rows:
            try:
                vector = json.loads(embedding_json)
                if isinstance(vector, list):
                    parsed.append((str(document_name), int(chunk_index), str(content), [float(x) for x in vector]))
            except Exception:
                continue
        return parsed

    def _list_documents(self, limit: int) -> List[Dict[str, Any]]:
        with self._db_lock:
            conn = sqlite3.connect(self._db_path)
            try:
                cur = conn.execute(
                    """
                    SELECT document_name, chunk_count, updated_at
                    FROM kb_documents
                    ORDER BY updated_at DESC
                    LIMIT ?
                    """,
                    (limit,),
                )
                rows = cur.fetchall()
            finally:
                conn.close()

        items: List[Dict[str, Any]] = []
        for document_name, chunk_count, updated_at in rows:
            items.append(
                {
                    "document_name": str(document_name),
                    "chunk_count": int(chunk_count),
                    "updated_at": str(updated_at),
                }
            )
        return items

    def _delete_document(self, document_name: str) -> bool:
        with self._db_lock:
            conn = sqlite3.connect(self._db_path)
            try:
                cur = conn.execute("SELECT 1 FROM kb_documents WHERE document_name = ? LIMIT 1", (document_name,))
                exists = cur.fetchone() is not None
                if not exists:
                    return False

                conn.execute("DELETE FROM kb_chunks WHERE document_name = ?", (document_name,))
                conn.execute("DELETE FROM kb_documents WHERE document_name = ?", (document_name,))
                conn.commit()
            finally:
                conn.close()

        file_path = self._docs_dir / document_name
        try:
            if file_path.exists():
                file_path.unlink()
        except Exception:
            # File cleanup failure does not block DB delete result.
            pass
        return True

    async def _embed_texts(self, texts: List[str]):
        if not texts:
            return Err(SdkError("待向量化文本为空"))
        assert self._cfg is not None

        url = f"{self._cfg.base_url.rstrip('/')}/embeddings"
        headers = {
            "Authorization": f"Bearer {self._cfg.api_key}",
            "Content-Type": "application/json",
        }

        vectors: List[List[float]] = []

        for start in range(0, len(texts), _EMBED_BATCH_SIZE):
            batch = texts[start : start + _EMBED_BATCH_SIZE]
            batch_vectors_res = await self._embed_with_retry(url, headers, batch)
            if isinstance(batch_vectors_res, Err):
                # Fallback: split into single-item requests to ride through unstable upstream links.
                self.logger.warning("batch embedding failed, fallback to single-item embedding")
                for one in batch:
                    one_res = await self._embed_with_retry(url, headers, [one])
                    if isinstance(one_res, Err):
                        self.logger.warning("single embedding failed, using local fallback vector")
                        vectors.append(_fallback_embedding(one))
                    else:
                        vectors.extend(one_res.value)
            else:
                vectors.extend(batch_vectors_res.value)

        if len(vectors) != len(texts):
            return Err(SdkError("Embedding 数量与输入文本数量不一致"))

        return Ok(vectors)

    async def _embed_with_retry(self, url: str, headers: Dict[str, str], inputs: List[str]):
        assert self._cfg is not None
        payload = {
            "model": self._cfg.embedding_model,
            "input": inputs,
        }

        data = None
        last_error = ""
        for attempt in range(1, _EMBED_MAX_RETRIES + 1):
            try:
                timeout = httpx.Timeout(timeout=_EMBED_REQUEST_TIMEOUT_SEC, connect=_EMBED_CONNECT_TIMEOUT_SEC)
                async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
                    resp = await client.post(url, headers=headers, json=payload)
                    resp.raise_for_status()
                    data = resp.json()
                break
            except httpx.HTTPStatusError as e:
                status = e.response.status_code if e.response is not None else -1
                body = ""
                try:
                    body = (e.response.text or "").strip() if e.response is not None else ""
                except Exception:
                    body = ""
                if len(body) > 320:
                    body = body[:320] + "..."
                last_error = f"HTTP {status} body={body or '<empty>'}"
                if status in (408, 409, 425, 429) or status >= 500:
                    if attempt < _EMBED_MAX_RETRIES:
                        await asyncio.sleep(0.2 * attempt)
                        continue
                return Err(SdkError(f"调用 Embedding 接口失败: {last_error}"))
            except (httpx.TimeoutException, httpx.TransportError) as e:
                last_error = f"{type(e).__name__}: {str(e) or '<empty>'}"
                if attempt < _EMBED_MAX_RETRIES:
                    await asyncio.sleep(0.2 * attempt)
                    continue
                return Err(SdkError(f"调用 Embedding 接口失败: {last_error}"))
            except Exception as e:
                last_error = f"{type(e).__name__}: {str(e) or '<empty>'}"
                return Err(SdkError(f"调用 Embedding 接口失败: {last_error}"))

        if data is None:
            return Err(SdkError(f"调用 Embedding 接口失败: {last_error or 'unknown error'}"))

        data_list = data.get("data") if isinstance(data, dict) else None
        if not isinstance(data_list, list) or not data_list:
            return Err(SdkError("Embedding 响应格式异常: 缺少 data"))

        vectors: List[List[float]] = []
        for item in data_list:
            emb = item.get("embedding") if isinstance(item, dict) else None
            if not isinstance(emb, list):
                return Err(SdkError("Embedding 响应格式异常: embedding 非数组"))
            try:
                vectors.append([float(x) for x in emb])
            except Exception:
                return Err(SdkError("Embedding 响应格式异常: embedding 含非法值"))

        if len(vectors) != len(inputs):
            return Err(SdkError("Embedding 数量与输入文本数量不一致"))

        return Ok(vectors)

    async def _chat_with_context(self, question: str, context_text: str):
        assert self._cfg is not None
        url = f"{self._cfg.base_url.rstrip('/')}/chat/completions"

        system_prompt = (
            "你是文档问答助手。"
            "请严格基于提供的文档片段回答。"
            "如果文档片段无法支持答案，请明确回答：文档中没有足够信息。"
        )
        user_prompt = (
            f"【文档片段】\n{context_text}\n\n"
            f"【用户问题】\n{question}\n\n"
            "请给出简洁、准确、可执行的回答。"
        )

        payload = {
            "model": self._cfg.chat_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.2,
        }
        headers = {
            "Authorization": f"Bearer {self._cfg.api_key}",
            "Content-Type": "application/json",
        }

        try:
            async with httpx.AsyncClient(timeout=90.0, trust_env=False) as client:
                resp = await client.post(url, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
        except Exception as e:
            return Err(SdkError(f"调用对话模型失败: {e}"))

        choices = data.get("choices")
        if not isinstance(choices, list) or not choices:
            return Err(SdkError("对话模型响应格式异常: 缺少 choices"))

        first = choices[0] if isinstance(choices[0], dict) else {}
        msg = first.get("message") if isinstance(first, dict) else {}
        content = msg.get("content") if isinstance(msg, dict) else None

        if not isinstance(content, str) or not content.strip():
            return Err(SdkError("对话模型响应格式异常: content 为空"))

        clean_content = content.strip()
        clean_content = re.sub(r"^<\|begin_of_box\|>", "", clean_content)
        clean_content = re.sub(r"<\|end_of_box\|>$", "", clean_content)
        clean_content = clean_content.strip()

        return Ok(clean_content)
