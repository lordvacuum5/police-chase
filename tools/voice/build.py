"""Records the police radio: every clip of lines.py, said by Kokoro, into resources/voice/*.bin.

    C:/Code/kokoro-voice/venv/Scripts/python build.py [cached: only what has been said before]

The voice (Kokoro-82M, Apache 2.0, with espeak-ng's pronunciations) is not in the game or its repository: it lives in
C:/Code/kokoro-voice (venv with onnxruntime, numpy and espeakng-loader; model/ with kokoro-v1.0.onnx, voices-v1.0.bin and
config.json; tts.py), or KOKORO. What has been said before is kept in its cache/, so only new lines take time.

A pack: 'PCV1', the header's length (u32), the header as JSON {rate, voices: {voice: {"words|f": [offset, samples]}}}, then each
clip as IMA ADPCM, 4 bits a sample, from a predictor and step of 0.
"""
import hashlib
import json
import os
import re
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
KOKORO = os.environ.get('KOKORO', 'C:/Code/kokoro-voice')
sys.path.insert(0, KOKORO)
sys.path.insert(0, HERE)
import numpy as np            # noqa: E402
import lines                  # noqa: E402

OUT = os.path.join(HERE, '..', '..', 'resources', 'voice')
CACHE = os.path.join(KOKORO, 'cache')
RATE = 8000
# Who is heard as which of Kokoro's voices, and how fast. Two for the units, by callsign.
VOICES = {
    'control': ('control', 'bf_emma', 1.12),
    'unitA': ('unit', 'bm_george', 1.18),
    'unitB': ('unit', 'bm_fable', 1.14),
    'air': ('air', 'bf_isabella', 1.12),
}
DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']


def spoken(t):
    """How it is written down for the voice."""
    def road(m):
        n = m.group(2)
        return m.group(1) + ' ' + (n if len(n) == 2 else ' '.join(DIGITS[int(c)] for c in n))
    t = re.sub(r'\b([ABM])(\d+)\b', road, t)
    t = re.sub(r'\bIndia 99\b', 'India nine nine', t, flags=re.I)
    t = re.sub(r'\bSt Mary\b', 'Saint Mary', t)
    t = t.replace('coupe', 'coo-pay').replace('iOS', 'eye oh ess')
    return t


def say(tts, text, cls, voice, speed):
    s = spoken(text)
    s = s if s[-1:] in '!?' else s + ('.' if cls == 'f' else ',')
    key = hashlib.sha1(('%s|%s|%s' % (s, voice, speed)).encode()).hexdigest()
    p = os.path.join(CACHE, key + '.npy')
    if os.path.exists(p):
        return np.load(p).astype(np.float32) / 32767
    if 'cached' in sys.argv:
        return None
    a = tts().say(s, voice, speed)
    np.save(p, (np.clip(a, -1, 1) * 32767).astype(np.int16))
    return a


def trim(a, sr=24000):
    """Off the silence each end, by 20 ms frames 38 dB under the loudest."""
    n = sr // 50
    f = len(a) // n
    if f < 3:
        return a
    e = np.sqrt((a[:f * n].reshape(f, n) ** 2).mean(1) + 1e-12)
    on = np.where(e > e.max() * 10 ** (-38 / 20))[0]
    i, j = max(0, on[0] - 1) * n, min(f, on[-1] + 3) * n
    return a[i:j].copy()


def to8k(a, sr=24000):
    """Down to RATE, what is over 3.6 kHz taken off first."""
    n = len(a)
    m = int(round(n * RATE / sr))
    F = np.fft.rfft(a)
    fr = np.fft.rfftfreq(n, 1 / sr)
    F *= np.clip((3800 - fr) / 300, 0, 1)
    k = m // 2 + 1
    G = np.zeros(k, complex)
    c = min(k, len(F))
    G[:c] = F[:c]
    return np.fft.irfft(G, m) * (m / n)


def level(a):
    """To one loudness, the peaks rounded off: what the transmitter's limiter does."""
    loud = np.abs(a) > np.abs(a).max() * 0.06
    r = np.sqrt((a[loud] ** 2).mean()) if loud.any() else 1
    a = np.tanh(a * (0.22 / max(r, 1e-4)) * 1.25) / 1.1
    k = min(len(a) // 4, RATE // 120)
    w = np.linspace(0, 1, k)
    a[:k] *= w
    a[-k:] *= w[::-1]
    return np.clip(a * 32000, -32000, 32000).astype(np.int32)


STEP = np.array([7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
                 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166,
                 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845,
                 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767])
MOVE = np.array([-1, -1, -1, -1, 2, 4, 6, 8])


def adpcm(clips):
    """IMA ADPCM of every clip at once, a sample at a time; a list of bytes."""
    n = max(len(c) for c in clips)
    n += n & 1
    X = np.zeros((len(clips), n), np.int32)
    for i, c in enumerate(clips):
        X[i, :len(c)] = c
    pred = np.zeros(len(clips), np.int32)
    idx = np.zeros(len(clips), np.int32)
    codes = np.zeros((len(clips), n), np.uint8)
    for t in range(n):
        st = STEP[idx]
        d = X[:, t] - pred
        sign = (d < 0).astype(np.int32)
        d = np.abs(d)
        q = np.minimum((d * 4) // st, 7)
        diff = st >> 3
        diff = diff + np.where(q & 4, st, 0) + np.where(q & 2, st >> 1, 0) + np.where(q & 1, st >> 2, 0)
        pred = np.clip(pred + np.where(sign == 1, -diff, diff), -32768, 32767)
        idx = np.clip(idx + MOVE[q], 0, 88)
        codes[:, t] = q | (sign << 3)
    out = []
    for i, c in enumerate(clips):
        k = len(c) + (len(c) & 1)
        out.append((codes[i, 0:k:2] | (codes[i, 1:k:2] << 4)).tobytes())
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    holder = []

    def tts():
        if not holder:
            import tts as T
            holder.append(T)
        return holder[0]
    packs, bad = lines.clips()
    if bad:
        print('UNREAD', bad)
    t0 = time.time()
    done = 0
    for pack, speakers in packs.items():
        names, sounds = [], []
        for voice, (who, kv, speed) in VOICES.items():
            # The second unit voice has no road names: where one is wanted the first says the line (RadioVoice.plan).
            if voice == 'unitB' and pack != 'common':
                continue
            for (key, cls), text in sorted(speakers.get(who, {}).items()):
                a = say(tts, text, cls, kv, speed)
                if a is None:
                    continue
                a = to8k(trim(a))
                names.append((voice, '%s|%s' % (key, cls)))
                sounds.append(level(a))
                done += 1
                if done % 100 == 0:
                    print(pack, done, round(time.time() - t0), 's', flush=True)
        if not sounds:
            continue
        order = np.argsort([len(s) for s in sounds])
        data = [None] * len(sounds)
        for k in range(0, len(order), 200):
            part = order[k:k + 200]
            for i, b in zip(part, adpcm([sounds[i] for i in part])):
                data[i] = b
        head, at = {'rate': RATE, 'voices': {v: {} for v in VOICES}}, 0
        for (v, k), s, b in zip(names, sounds, data):
            head['voices'][v][k] = [at, len(s)]
            at += len(b)
        h = json.dumps(head, separators=(',', ':')).encode()
        with open(os.path.join(OUT, pack + '.bin'), 'wb') as f:
            f.write(b'PCV1' + struct.pack('<I', len(h)) + h + b''.join(data))
        print(pack, len(sounds), 'clips', round(sum(map(len, sounds)) / RATE), 's', round((at + len(h)) / 1e6, 2), 'MB', flush=True)


main()
