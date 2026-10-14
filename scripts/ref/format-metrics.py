"""Format metrics for one or more projects: pacing, holds, text, ratings, bar.
Compares a generated project with a hand-edited benchmark, e.g. the short-form
one (projects/snaptik-7541156735361289485-v3-82b5).
usage: python3 -I scripts/ref/format-metrics.py <project.json> [<project.json> ...]"""
import json, math, re, statistics as st, sys

SLOPE = 0.184
NEG = {'inaccuracy', 'mistake', 'miss', 'blunder'}
INTRO = 0.75  # creator theme: badge delay + pop + card in


def fill(e):
    if e is None: return None
    if 'mate' in e and e['mate'] is not None: return 1.0 if e['mate'] > 0 else 0.0
    return 0.5 + 0.5 * math.tanh(SLOPE * e['pawns'])


def words(t): return len((t or '').split())


def sentences(t): return len([s for s in re.split(r'[.!?]+(?:\s|$)', (t or '').strip()) if s.strip()])


def auto_hold(m, wps=5.5, fade=0.12, reread=4.0):
    n = words(m.get('explanation'))
    return INTRO + ((n - 1) / wps + fade if n else 0) + reread


def fmt(xs, d=1):
    xs = [x for x in xs if x is not None]
    if not xs: return '-'
    return f"mean {st.mean(xs):.{d}f}  median {st.median(xs):.{d}f}  [{min(xs):.{d}f}-{max(xs):.{d}f}]"


def report(path):
    p = json.load(open(path))
    dur = p['source']['durationSec']
    ms = sorted(p['moments'], key=lambda m: m['sourceTime'])
    chars = {c['id']: c for c in p['context']['characters']}
    t = [m['sourceTime'] for m in ms]
    holds = [m['holdSec'] for m in ms]
    out = dur + sum(holds)
    print(f"=== {p.get('title') or p['id']}  ({p['source']['width']}x{p['source']['height']}, {dur:.1f} s, theme {p['themeId']})")
    print(f"cards {len(ms)}  = one per {dur/max(1,len(ms)):.1f} s source; first at {t[0]:.1f} s; last at {t[-1]:.1f} s ({dur-t[-1]:.1f} s before end)")
    print(f"gaps between cards (source s): {fmt([b-a for a,b in zip(t,t[1:])])}")
    print(f"holds: {fmt(holds)}  total {sum(holds):.1f} s; output {out:.1f} s, holds are {100*sum(holds)/out:.0f}% of it")
    print(f"  holds if auto under creator look, long-form (4 s reread): {fmt([auto_hold(m) for m in ms])}, total {sum(auto_hold(m) for m in ms):.1f}")
    sh = [auto_hold(m, reread=1.4) for m in ms]
    print(f"  holds if auto under creator look, short-form (1.4 s reread): {fmt(sh)}, total {sum(sh):.1f}; output {dur+sum(sh):.1f} s, holds {100*sum(sh)/(dur+sum(sh)):.0f}%")
    rr = [m['holdSec'] - INTRO - (((words(m['explanation'])-1)/5.5 + .12) if words(m['explanation']) else 0) for m in ms]
    print(f"  implied reread after the last word (creator intro 0.75 s, 5.5 w/s): {fmt(rr, 2)}")
    lab = [m['moveLabel'].strip() for m in ms]
    print(f"label chars {fmt([len(x) for x in lab])}; words {fmt([words(x) for x in lab])}; Title Case {sum(1 for x in lab if all(w[:1].isupper() or not w[:1].isalpha() for w in x.strip('\"').split()))}/{len(lab)}; quoted {sum(1 for x in lab if x.startswith('\"'))}")
    ex = [m['explanation'] for m in ms]
    print(f"explanation words {fmt([words(x) for x in ex])}; chars {fmt([len(x) for x in ex], 0)}; sentences {fmt([sentences(x) for x in ex])}")
    bm = [m.get('bestMove') for m in ms]
    print(f"best move on {sum(1 for b in bm if b)}/{len(ms)}; chars {fmt([len(b) for b in bm if b])}; motif on {sum(1 for m in ms if m.get('motif'))}/{len(ms)}")
    cls = [m['classification'] for m in ms]
    print(f"ratings: {', '.join(cls)}  (negative {sum(c in NEG for c in cls)}/{len(cls)})")
    actors = [chars.get(m.get('actorId'), {}).get('name', '-') for m in ms]
    print(f"actors: {', '.join(actors)}")
    print(f"sides: {', '.join(c['name'] + '=' + str(c.get('side')) for c in chars.values())}")
    bar = p.get('evalBar') or {}
    beats = sorted(bar.get('beats', []), key=lambda b: b['sourceTime'])
    kf = sorted([(b['sourceTime'], 'beat', b['eval'], None) for b in beats] + [(m['sourceTime'], 'card', m.get('eval'), m['classification']) for m in ms if m.get('eval')], key=lambda k: k[0])
    prev = fill(bar.get('start', {'pawns': 0}))
    card_sw, beat_sw = [], []
    line = []
    for at, kind, e, c in kf:
        f = fill(e); sw = 100 * (f - prev)
        (card_sw if kind == 'card' else beat_sw).append(abs(sw))
        tag = c or 'beat'
        val = f"M{e['mate']}" if e.get('mate') is not None else f"{e['pawns']:+.1f}"
        line.append(f"{at:.1f} {tag} {val} ({sw:+.0f}%)")
        prev = f
    print("bar: " + ' | '.join(line))
    fills = [fill(k[2]) for k in kf]
    print(f"bar fill range {100*min(fills):.0f}-{100*max(fills):.0f}%; card swings {fmt(card_sw,0)}%; beats {len(beats)}, swings {fmt(beat_sw,0)}%")
    allt = sorted(k[0] for k in kf)
    print(f"seconds between bar changes: {fmt([b-a for a,b in zip(allt,allt[1:])])}")
    for m in ms:
        print(f"  {m['sourceTime']:5.1f} hold {m['holdSec']:.1f} {m['classification']:<10} {m['moveLabel'].strip()!r:<28} {m['explanation']!r}  best={m.get('bestMove')!r} motif={m.get('motif')!r}")
    print()


for a in sys.argv[1:]: report(a)
