"""Every radio line the game can say, out of its source, as the clips to record.

    python lines.py            counts, and anything it could not read

A line is a template ("{cs}, {dir}{on road}, {speed}."): what is written between its gaps is recorded whole, and what
goes in a gap (a callsign, a direction, a speed, a road) by itself. The game puts them back together (src/game/radiovoice.js).
A clip is said two ways: 'f', coming down at the end of the sentence, or 'm', with more to come.
"""
import glob
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
NAMES = json.load(open(os.path.join(HERE, 'names.json'), encoding='utf-8'))
DIRS = ['northbound', 'southbound', 'eastbound', 'westbound']
CARS = ['a blue-grey coupe', 'an orange sports car', 'a grey four-by-four', 'the suspect vehicle']
REASONS = ['obstructing a police officer', 'failing to stop', 'matching an earlier suspect', 'a request from the control room',
           'running a red light', 'driving dangerously', 'ramming a patrol car', 'the daily challenge']
WHATS = ['failed to stop after a collision with a police vehicle', 'failed to stop after a collision', 'through a red light',
         'making off at speed', 'obstructing a police vehicle']
SPEEDS = [str(n) for n in range(10, 210, 10)]
UNITS = ['unit %d' % n for n in range(1, 41)]

START = re.compile(r"(?:\.say|\._say|phrases\.pick|\.radio)\(|const lines = |\blines = (?=\[)")
TEXT = re.compile(r"`((?:[^`\\]|\\.)*)`" + r"|'((?:[^'\\\n]|\\.)*)'" + r'|"((?:[^"\\\n]|\\.)*)"')
ROAD_ALL = "${x.road ? ' ' + x.road : ' in your area'}"
ROAD_LAST = "${x.road ? ' ' + x.road.replace(/^on /, '') : ' the last location'}"


def templates():
    """(file, template) for every wording in a say(), or in a constant full of them."""
    out = set()
    for path in sorted(glob.glob(os.path.join(ROOT, 'src', '**', '*.js'), recursive=True)):
        src = open(path, encoding='utf-8').read()
        src = re.sub(r'^\s*(//|\*|/\*).*$', '', src, flags=re.M)
        # These hold quotes of their own.
        src = src.replace(ROAD_ALL, ' ${x.road}').replace(ROAD_LAST, ' ${x.node}')
        src = re.sub(r"^(\s*)(//.*)$", r'\1', src, flags=re.M)
        for m in START.finditer(src):
            k, depth, q = m.end(), 1 if m.group().endswith('(') else 0, None
            while k < len(src):
                c = src[k]
                if q:
                    if c == '\\':
                        k += 1
                    elif c == q:
                        q = None
                elif c in '\'"`':
                    q = c
                elif c in '([{':
                    depth += 1
                elif c in ')]}':
                    depth -= 1
                    if depth <= 0:
                        break
                elif c == ';' and depth <= 0:
                    break
                k += 1
            for t in TEXT.finditer(src[m.end():k]):
                s = next(g for g in t.groups() if g is not None).replace("\\'", "'").replace('\\"', '"')
                if ' ' in s and not s.startswith('[') and re.search(r'[.!?]$', s):
                    out.add((os.path.basename(path), s))
    return sorted(out)


SLOT = [(r"^[xv]\.car$", 'car'), (r"^[xv]\.(cs|p)$", 'cs'), (r"^on\([xv]\.road\)$", 'onroad?'), (r"^[xv]\.road$", 'onroad'),
        (r"^[xv]\.dir$", 'dir'), (r"^[xv]\.speed$", 'speed'), (r"^[xv]\.(junction|node|site)$", 'place'),
        (r"^[xv]\.reason$", 'reason'), (r"^[xv]\.what$", 'what')]


def slots(t):
    """A template in pieces: text, or ('slot', name)."""
    t = t.replace('${v.dir}bound', '${v.dir}').replace('${word}bound', '${v.dir}')
    out, at = [], 0
    for m in re.finditer(r'\$\{([^}]*)\}', t):
        out.append(t[at:m.start()])
        name = next((n for rx, n in SLOT if re.search(rx, m.group(1))), None)
        if not name:
            raise ValueError(m.group(1))
        out.append(('slot', name))
        at = m.end()
    out.append(t[at:])
    return out


def speakable(s):
    """As speakable() in src/game/audio.js."""
    s = re.sub('\\s*[\u2014\u2013]\\s*', ', ', s)
    s = re.sub(r'\s+/\s+', ' and ', s)
    s = re.sub(r'\bU(\d+)\b', r'Unit \1', s)
    s = re.sub(r'\bPIT\b', 'pit', s)
    return re.sub(r'\s+', ' ', s).strip()


def tokens(s):
    return re.findall(r"[a-z0-9]+(?:'[a-z]+)*|[.,!?]", speakable(s).lower().replace('\u2019', "'").replace('-', ' '))


def clip(s):
    """(key, class) of a piece of text: its words and the punctuation inside it, and how it ends."""
    tk = tokens(s)
    while tk and tk[0] in '.,!?':
        tk = tk[1:]
    end = 'm'
    while tk and tk[-1] in '.,!?':
        if tk[-1] != ',':
            end = 'f'
        tk = tk[:-1]
    return (' '.join(tk), end) if tk else None


def speakers(f, t):
    """As voiceFor() there; more than one where the caller may be either."""
    if re.search(r'India 99|Air support', t, re.I):
        return ['air']
    if re.match(r'(Control\b|All units\b)', t, re.I):
        return ['control']
    if not t.startswith('${'):
        return ['control']
    if f == 'suspects.js':
        return ['unit', 'control']
    if f == 'commentary.js' and re.search(r'eyes on!|got them again|found them!', t):
        return ['unit', 'control', 'air']
    if f == 'commentary.js' and re.search(r'last seen|lost them|no longer|pushed free|forced|shoved|stopped|pinned|blocked in|nowhere|boxed in', t):
        return ['unit', 'control']
    return ['unit']


def clips():
    """{pack: {speaker: {(key, class): text}}}, and what could not be read."""
    packs, bad = {'common': {}}, []

    def put(pack, who, text, cls=None):
        c = clip(text)
        if not c:
            return
        key = (c[0], cls or c[1])
        body = speakable(text).strip(' ,.!?')
        last = re.search(r'[!?]$', text.rstrip())
        packs.setdefault(pack, {}).setdefault(who, {}).setdefault(key, body + (last.group() if last and key[1] == 'f' else ''))

    for f, t in templates():
        try:
            ps = slots(t)
        except ValueError as e:
            bad.append((f, t, str(e)))
            continue
        for who in speakers(f, t):
            for i, p in enumerate(ps):
                if isinstance(p, tuple):
                    continue
                # Mid-sentence if a gap follows with nothing closing it first.
                more = i + 1 < len(ps) and not re.search(r'[.!?]\s*$', p)
                put('common', who, p, 'm' if more else None)
                # A road that may not be there: this piece may be the end of it.
                if i + 2 < len(ps) and ps[i + 1] == ('slot', 'onroad?') and ps[i + 2][:1] in ('.', '!', '?'):
                    put('common', who, p, 'f')
    both = ('m', 'f')
    for who in ('unit', 'control', 'air'):
        for s in DIRS + ['the junction', 'the road ahead', 'in the city', 'in your area', 'the last location']:
            for c in both:
                put('common', who, s, c)
        for s in ['control', 'control, all units', 'all units', 'india 99', 'and']:
            put('common', who, s, 'm')
    for who in ('unit', 'air'):
        for s in SPEEDS:
            for c in both:
                put('common', who, s, c)
    for u in UNITS:
        put('common', 'unit', u, 'm')
        put('common', 'unit', u, 'f')
        put('common', 'control', u, 'm')
        put('common', 'control', u, 'f')
    for c in both:
        for x in CARS:
            put('common', 'unit', x, c)
        for x in WHATS:
            put('common', 'unit', x, c)
            put('common', 'control', x, c)
    for x in REASONS:
        put('common', 'control', x, 'f')
    for m, roads in NAMES.items():
        for r in roads:
            # "on Eighth Street" to end on or go on from, "Eighth Street" to go on from, and "and Mercer Street" to end a junction.
            for c in both:
                put(m, 'unit', 'on ' + r, c)
            put(m, 'unit', r, 'm')
            put(m, 'unit', 'and ' + r, 'f')
            put(m, 'control', 'on ' + r, 'f')
            put(m, 'control', r, 'f')
            put(m, 'air', 'on ' + r, 'm')
    return packs, bad


def samples(seed=1):
    """Whole lines as the game would say them, every template a few times over, for tests/radiovoice.js."""
    import random
    r = random.Random(seed)
    out = []
    for f, t in templates():
        ps = slots(t)
        for m, roads in NAMES.items():
            road = lambda: r.choice(roads)
            fill = {'car': lambda: r.choice(CARS), 'cs': lambda: 'U%d' % r.randint(1, 30), 'onroad?': lambda: r.choice(['', ' on ' + road()]),
                    'onroad': lambda: r.choice(['in the city', 'on ' + road()]), 'dir': lambda: r.choice(DIRS), 'speed': lambda: r.choice(SPEEDS[:16]),
                    'place': lambda: road() if 'site' in t or 'roadblock' in f else road() + ' / ' + road(), 'reason': lambda: r.choice(REASONS), 'what': lambda: r.choice(WHATS)}
            out.append([m, ''.join(p if isinstance(p, str) else fill[p[1]]() for p in ps)])
    return out


if __name__ == '__main__':
    import sys
    if 'samples' in sys.argv:
        json.dump(samples(), open(os.path.join(ROOT, 'tests', 'data', 'radiolines.json'), 'w'), indent=0)
        sys.exit()
    p, bad = clips()
    print(len(templates()), 'templates')
    for k, v in p.items():
        print(k, {w: len(x) for w, x in v.items()})
    print('unread', bad)
    for who in ('control', 'air', 'unit'):
        print(who, ' | '.join('%s/%s' % (t, k[1]) for k, t in list(p['common'][who].items())[:400]))
