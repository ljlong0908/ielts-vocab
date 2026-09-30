"""跨运行时同值的文本 → 文件名 key。

为什么单独成文件：`hash_text()` 的结果会变成云存储里的音频文件名
（`s_<hash>.mp3`），**本地生成方与云端查询方必须算出同一个值**，否则
「本地传上去了、云端查不到」，表现为静默不播，很难查。

三条链路都要对齐（改动时四处一起看）：
    scripts/text_key.py        ← 本文件（Python 侧唯一实现）
    cloudfunctions/seed_audio/index.js      hashText()
    cloudfunctions/audio_cache/index.js     hashText()

⚠️ 不要改成「更标准」的 md5/sha1：已入库的音频文件名是按这里的 JS int32 语义
   算出来的，改算法等于让线上 200+ 条 audio_cache 全部对不上。
"""


def _int32(x: int) -> int:
    """模拟 JS 的 `x | 0`：截断到有符号 32 位。"""
    x &= 0xFFFFFFFF
    return x - 0x100000000 if x >= 0x80000000 else x


def _base36(n: int) -> str:
    """JS `Number.prototype.toString(36)` 的等价实现（n 为非负整数）。"""
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if n == 0:
        return "0"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out


def hash_text(text: str) -> str:
    """与两个云函数的 `hashText()` 完全一致（JS int32 语义）。

    即 JS 里的 `h = ((h << 5) - h) + charCodeAt(i)`，每次运算后按 int32 截断，
    最后取绝对值转 36 进制。空串会得到 "0"，非空串不会，故可安全用作文件名。
    """
    h = 0
    for ch in text:
        h = _int32(_int32(h << 5) - h + ord(ch))
    return _base36(abs(h))
